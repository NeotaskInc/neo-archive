use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, ffi};
use std::{ffi::c_void, ptr};
use tantivy::tokenizer::{PreTokenizedString, Token};

/// Owns SQLite's unicode61 tokenizer and its originating connection. This keeps
/// Tantivy's terms and positions compatible with the existing FTS5 archive.
pub struct ArchiveTokenizer {
    instance: *mut ffi::Fts5Tokenizer,
    callbacks: ffi::fts5_tokenizer,
    _connection: Connection,
}

impl ArchiveTokenizer {
    pub fn new() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        let mut api: *mut ffi::fts5_api = ptr::null_mut();
        let mut statement = ptr::null_mut();
        // SQLite's documented fts5_api acquisition protocol. The API pointer is
        // filled synchronously while `api` and the connection remain alive.
        unsafe {
            let prepared = ffi::sqlite3_prepare_v2(
                connection.handle(),
                c"SELECT fts5(?1)".as_ptr(),
                -1,
                &mut statement,
                ptr::null_mut(),
            );
            ensure!(
                prepared == ffi::SQLITE_OK,
                "Cannot prepare FTS5 API lookup: {prepared}"
            );
            let bound = ffi::sqlite3_bind_pointer(
                statement,
                1,
                (&mut api as *mut *mut ffi::fts5_api).cast(),
                c"fts5_api_ptr".as_ptr(),
                None,
            );
            let stepped = if bound == ffi::SQLITE_OK {
                ffi::sqlite3_step(statement)
            } else {
                bound
            };
            ffi::sqlite3_finalize(statement);
            ensure!(
                stepped == ffi::SQLITE_ROW && !api.is_null(),
                "FTS5 API unavailable: {stepped}"
            );
            let mut context = ptr::null_mut();
            let mut callbacks = ffi::fts5_tokenizer {
                xCreate: None,
                xDelete: None,
                xTokenize: None,
            };
            let find = (*api)
                .xFindTokenizer
                .context("FTS5 tokenizer lookup unavailable")?;
            let found = find(api, c"unicode61".as_ptr(), &mut context, &mut callbacks);
            ensure!(
                found == ffi::SQLITE_OK,
                "unicode61 tokenizer unavailable: {found}"
            );
            let create = callbacks
                .xCreate
                .context("Tokenizer constructor unavailable")?;
            ensure!(
                callbacks.xDelete.is_some() && callbacks.xTokenize.is_some(),
                "Incomplete tokenizer interface"
            );
            let mut instance = ptr::null_mut();
            let created = create(context, ptr::null_mut(), 0, &mut instance);
            ensure!(
                created == ffi::SQLITE_OK && !instance.is_null(),
                "Cannot create unicode61 tokenizer: {created}"
            );
            Ok(Self {
                instance,
                callbacks,
                _connection: connection,
            })
        }
    }

    pub fn tokenize(&mut self, text: &str) -> Result<PreTokenizedString> {
        let len: i32 = text
            .len()
            .try_into()
            .context("Text exceeds SQLite's tokenizer limit")?;
        let mut output = TokenOutput {
            tokens: Vec::new(),
            invalid: false,
        };
        // SQLite calls collect synchronously and does not retain either pointer.
        // The callback validates byte lengths and never unwinds through C.
        let code = unsafe {
            self.callbacks
                .xTokenize
                .context("Tokenizer callback unavailable")?(
                self.instance,
                (&mut output as *mut TokenOutput).cast(),
                ffi::FTS5_TOKENIZE_DOCUMENT,
                text.as_ptr().cast(),
                len,
                Some(collect),
            )
        };
        if code != ffi::SQLITE_OK || output.invalid {
            bail!("Archive tokenization failed: {code}");
        }
        Ok(PreTokenizedString {
            text: text.to_owned(),
            tokens: output.tokens,
        })
    }
}

struct TokenOutput {
    tokens: Vec<Token>,
    invalid: bool,
}

unsafe extern "C" fn collect(
    context: *mut c_void,
    flags: i32,
    bytes: *const std::ffi::c_char,
    len: i32,
    start: i32,
    end: i32,
) -> i32 {
    if context.is_null() || bytes.is_null() || len < 0 || start < 0 || end < start {
        return ffi::SQLITE_ERROR;
    }
    // Both pointers are supplied by tokenize/SQLite and valid for this callback.
    let output = unsafe { &mut *context.cast::<TokenOutput>() };
    let token_bytes = unsafe { std::slice::from_raw_parts(bytes.cast::<u8>(), len as usize) };
    let Ok(text) = std::str::from_utf8(token_bytes) else {
        output.invalid = true;
        return ffi::SQLITE_ERROR;
    };
    let position = output.tokens.last().map_or(0, |previous| {
        previous.position + usize::from(flags & ffi::FTS5_TOKEN_COLOCATED == 0)
    });
    output.tokens.push(Token {
        offset_from: start as usize,
        offset_to: end as usize,
        position,
        text: text.to_owned(),
        position_length: 1,
    });
    ffi::SQLITE_OK
}

impl Drop for ArchiveTokenizer {
    fn drop(&mut self) {
        // The tokenizer is deleted once, before the owning connection is dropped.
        if let Some(delete) = self.callbacks.xDelete {
            unsafe { delete(self.instance) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_fts5_terms_and_positions() -> Result<()> {
        let db = Connection::open_in_memory()?;
        db.execute_batch("create virtual table f using fts5(text); create virtual table vocab using fts5vocab(f, instance);")?;
        let mut tokenizer = ArchiveTokenizer::new()?;
        for text in [
            "café naïve 東京",
            "rust-based C++ node.js",
            "foo_bar foo bar",
            "Straße Æsir İSTANBUL",
            "a\0b café\u{301} 👩🏽‍💻",
            "",
        ] {
            db.execute("delete from f", [])?;
            db.execute("insert into f(text) values (?)", [text])?;
            let expected = db
                .prepare("select term, offset from vocab order by offset, term")?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let actual = tokenizer
                .tokenize(text)?
                .tokens
                .into_iter()
                .map(|t| (t.text, t.position))
                .collect::<Vec<_>>();
            assert_eq!(actual, expected, "{text:?}");
        }
        Ok(())
    }
}
