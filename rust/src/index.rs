use crate::tokenizer::ArchiveTokenizer;
use anyhow::{Context, Result, ensure};
use fs4::fs_std::FileExt;
use regex::Regex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs::OpenOptions, path::Path, sync::LazyLock, time::Duration};
use tantivy::{
    Index, Order, TantivyDocument, Term,
    collector::TopDocs,
    query::{AllQuery, BooleanQuery, EmptyQuery, Occur, PhraseQuery, Query, TermQuery},
    schema::{FAST, Field, IndexRecordOption, STORED, STRING, Schema, TEXT, Value},
};

const GENERATION_TABLE: &str = "neo_archive_search_generation";
const INDEX_VERSION: &str = "neoarchive-tantivy-unicode61-v1";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequest {
    pub query: String,
    pub account_id: Option<String>,
    pub resource: Option<String>,
    #[serde(default)]
    pub liked: bool,
    #[serde(default)]
    pub bookmarked: bool,
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub protocol_version: u32,
    pub instance_id: String,
    pub generation: i64,
    pub ids: Vec<String>,
    pub exhausted: bool,
    pub rebuilt: bool,
}

struct Fields {
    id: Field,
    text: Field,
    scope: Field,
    kind: Field,
    order: Field,
}

fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let id = builder.add_text_field("id", STRING | STORED);
    let text = builder.add_text_field("text", TEXT);
    let scope = builder.add_text_field("scope", STRING);
    let kind = builder.add_text_field("kind", STRING);
    let order = builder.add_u64_field("order", FAST);
    (
        builder.build(),
        Fields {
            id,
            text,
            scope,
            kind,
            order,
        },
    )
}

/// Durable invalidation belongs to SQLite so every writer participates, including
/// existing TypeScript imports, live sync, restores and manual database updates.
fn install_generation_tracking(db: &Connection) -> Result<()> {
    let installed: i64 = db.query_row(
        "select count(*) from sqlite_master where (type='table' and name='neo_archive_search_generation')
        or (type='trigger' and name in (
            'neo_archive_search_tweets_insert','neo_archive_search_tweets_update','neo_archive_search_tweets_delete',
            'neo_archive_search_tweet_account_edges_insert','neo_archive_search_tweet_account_edges_update','neo_archive_search_tweet_account_edges_delete',
            'neo_archive_search_tweet_collections_insert','neo_archive_search_tweet_collections_update','neo_archive_search_tweet_collections_delete'
        ))", [], |row| row.get(0),
    )?;
    if installed == 10 {
        return Ok(());
    }
    db.execute_batch("begin immediate;
        create table if not exists neo_archive_search_generation (
            singleton integer primary key check(singleton = 1), generation integer not null,
            instance_id text not null
        );
        insert or ignore into neo_archive_search_generation values (1, 0, lower(hex(randomblob(16))));")?;
    let install = (|| -> Result<()> {
        for table in ["tweets", "tweet_account_edges", "tweet_collections"] {
            for operation in ["insert", "update", "delete"] {
                db.execute_batch(&format!(
                    "create trigger if not exists neo_archive_search_{table}_{operation}
                    after {operation} on {table} begin
                    update {GENERATION_TABLE} set generation = generation + 1 where singleton = 1;
                    end;"
                ))?;
            }
        }
        // Repairing missing triggers invalidates an index that may have missed
        // writes while tracking was incomplete.
        db.execute(
            "update neo_archive_search_generation set generation=generation+1 where singleton=1",
            [],
        )?;
        Ok(())
    })();
    match install {
        Ok(()) => db.execute_batch("commit")?,
        Err(error) => {
            db.execute_batch("rollback")?;
            return Err(error);
        }
    }
    Ok(())
}

fn generation(db: &Connection) -> Result<i64> {
    Ok(db.query_row(
        "select generation from neo_archive_search_generation where singleton = 1",
        [],
        |row| row.get(0),
    )?)
}

fn scope(kind: &str, account: &str) -> String {
    format!("{kind}\u{1f}{account}")
}

fn rebuild(index: &Index, fields: &Fields, db: &Connection, generation: &str) -> Result<()> {
    let mut tokenizer = ArchiveTokenizer::new()?;
    let mut writer = index.writer_with_num_threads::<TantivyDocument>(1, 32_000_000)?;
    writer.delete_all_documents()?;
    let mut memberships = db.prepare(
        "select account_id, kind from tweet_account_edges where tweet_id = ?
         union select account_id, kind from tweet_collections where tweet_id = ?",
    )?;
    let mut tweets = db.prepare(
        "select id, text from tweets where deleted_at is null and superseded_at is null
         order by created_at asc, id asc",
    )?;
    let rows = tweets.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for (ordinal, row) in rows.enumerate() {
        let (id, text) = row?;
        let mut doc = TantivyDocument::new();
        doc.add_text(fields.id, &id);
        doc.add_u64(fields.order, ordinal as u64);
        doc.add_pre_tokenized_text(fields.text, tokenizer.tokenize(&text)?);
        let memberships = memberships
            .query_map([&id, &id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut likes = HashSet::new();
        let mut bookmarks = HashSet::new();
        for (account, kind) in &memberships {
            doc.add_text(fields.kind, kind);
            doc.add_text(fields.scope, scope(kind, account));
            if kind == "likes" {
                likes.insert(account);
            }
            if kind == "bookmarks" {
                bookmarks.insert(account);
            }
        }
        for account in likes.intersection(&bookmarks) {
            doc.add_text(fields.kind, "likes_and_bookmarks");
            doc.add_text(fields.scope, scope("likes_and_bookmarks", account));
        }
        writer.add_document(doc)?;
    }
    let mut commit = writer.prepare_commit()?;
    commit.set_payload(generation);
    commit.commit()?;
    writer.wait_merging_threads()?;
    Ok(())
}

fn text_query(
    text: &str,
    field: Field,
    tokenizer: &mut ArchiveTokenizer,
) -> Result<Box<dyn Query>> {
    static TERMS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\p{L}\p{N}_]+").expect("constant query regex"));
    let mut clauses = Vec::new();
    for term in TERMS.find_iter(text) {
        let tokens = tokenizer.tokenize(term.as_str())?.tokens;
        let query: Box<dyn Query> = match tokens.len() {
            0 => Box::new(EmptyQuery),
            1 => Box::new(TermQuery::new(
                Term::from_field_text(field, &tokens[0].text),
                IndexRecordOption::WithFreqsAndPositions,
            )),
            _ => Box::new(PhraseQuery::new_with_offset(
                tokens
                    .into_iter()
                    .map(|token| (token.position, Term::from_field_text(field, &token.text)))
                    .collect(),
            )),
        };
        clauses.push((Occur::Must, query));
    }
    if clauses.is_empty() {
        Ok(Box::new(AllQuery))
    } else {
        Ok(Box::new(BooleanQuery::new(clauses)))
    }
}

pub fn search(db_path: &Path, index_path: &Path, request: &SearchRequest) -> Result<SearchResult> {
    ensure!(
        request.limit > 0 && request.limit <= 1_000_000,
        "Search limit must be between 1 and 1000000"
    );
    ensure!(
        request.offset.checked_add(request.limit).is_some(),
        "Search offset overflow"
    );
    ensure!(db_path.is_file(), "Archive database does not exist");
    std::fs::create_dir_all(index_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(index_path.join("neoarchive.lock"))?;
    lock.lock_exclusive()?;
    let db = Connection::open(db_path)?;
    db.busy_timeout(Duration::from_secs(30))?;
    install_generation_tracking(&db)?;
    db.execute_batch("begin")?;
    let current_generation = generation(&db)?;
    let instance_id: String = db.query_row(
        "select instance_id from neo_archive_search_generation where singleton=1",
        [],
        |row| row.get(0),
    )?;
    let (schema, fields) = schema();
    let index =
        Index::open_or_create(tantivy::directory::MmapDirectory::open(index_path)?, schema)?;
    let expected = format!("{INDEX_VERSION}:{instance_id}:{current_generation}");
    let rebuilt = index.load_metas()?.payload.as_deref() != Some(expected.as_str());
    if rebuilt {
        rebuild(&index, &fields, &db, &expected)?;
    }
    let mut tokenizer = ArchiveTokenizer::new()?;
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(
        Occur::Must,
        text_query(&request.query, fields.text, &mut tokenizer)?,
    )];
    let kind = if request.liked && request.bookmarked {
        "likes_and_bookmarks"
    } else if request.liked {
        "likes"
    } else if request.bookmarked {
        "bookmarks"
    } else {
        match request.resource.as_deref().unwrap_or("home") {
            "mentions" => "mention",
            "home" => "home",
            "authored" => "authored",
            "search" => "search",
            _ => anyhow::bail!("Unsupported archive resource"),
        }
    };
    let filter = match &request.account_id {
        Some(account) => Term::from_field_text(fields.scope, &scope(kind, account)),
        None => Term::from_field_text(fields.kind, kind),
    };
    clauses.push((
        Occur::Must,
        Box::new(TermQuery::new(filter, IndexRecordOption::Basic)),
    ));
    let query = BooleanQuery::new(clauses);
    let reader = index.reader()?;
    let searcher = reader.searcher();
    let results = searcher.search(
        &query,
        &TopDocs::with_limit(request.limit)
            .and_offset(request.offset)
            .order_by_fast_field::<u64>("order", Order::Desc),
    )?;
    let exhausted = results.len() < request.limit;
    let mut ids = Vec::with_capacity(results.len());
    for (_, address) in results {
        let doc = searcher.doc::<TantivyDocument>(address)?;
        ids.push(
            doc.get_first(fields.id)
                .and_then(|v| v.as_str())
                .context("Index document missing tweet ID")?
                .to_owned(),
        );
    }
    db.execute_batch("commit")?;
    Ok(SearchResult {
        protocol_version: 1,
        instance_id,
        generation: current_generation,
        ids,
        exhausted,
        rebuilt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Result<(tempfile::TempDir, std::path::PathBuf)> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("archive.sqlite");
        Connection::open(&path)?.execute_batch("create table tweets(id text primary key, text text, created_at text, deleted_at text, superseded_at text);
            create table tweet_account_edges(account_id text,tweet_id text,kind text);
            create index edges_tweet on tweet_account_edges(tweet_id);
            create table tweet_collections(account_id text,tweet_id text,kind text);
            create index collections_tweet on tweet_collections(tweet_id);
            insert into tweets values ('1','café rust compiler','2026-01-01',null,null),('2','rust only','2026-01-02',null,null),('3','compiler only','2026-01-02',null,null),('4','café rust compiler','2026-01-03','2026-01-04',null);
            insert into tweet_account_edges values ('a','1','authored'),('a','2','authored'),('b','3','authored'),('a','4','authored');
            insert into tweet_collections values ('a','1','likes'),('b','1','bookmarks'),('a','2','likes'),('a','2','bookmarks');")?;
        Ok((dir, path))
    }

    #[test]
    fn preserves_matching_order_account_intersection_and_live_updates() -> Result<()> {
        let (dir, db_path) = fixture()?;
        let index_path = dir.path().join("index");
        let mut request = SearchRequest {
            query: "cafe rust compiler".into(),
            resource: Some("authored".into()),
            limit: 20,
            ..Default::default()
        };
        let first = search(&db_path, &index_path, &request)?;
        assert_eq!(first.ids, ["1"]);
        assert!(first.rebuilt);
        assert!(!search(&db_path, &index_path, &request)?.rebuilt);
        request.query.clear();
        assert_eq!(
            search(&db_path, &index_path, &request)?.ids,
            ["3", "2", "1"]
        );
        request.account_id = Some("a".into());
        assert_eq!(search(&db_path, &index_path, &request)?.ids, ["2", "1"]);
        request.account_id = None;
        request.liked = true;
        request.bookmarked = true;
        assert_eq!(search(&db_path, &index_path, &request)?.ids, ["2"]);
        Connection::open(&db_path)?.execute(
            "insert into tweet_collections values ('a','1','bookmarks')",
            [],
        )?;
        let refreshed = search(&db_path, &index_path, &request)?;
        assert_eq!(refreshed.ids, ["2", "1"]);
        assert!(refreshed.generation > first.generation);
        Connection::open(&db_path)?.execute(
            "update tweets set superseded_at='2026-01-04' where id='2'",
            [],
        )?;
        assert_eq!(search(&db_path, &index_path, &request)?.ids, ["1"]);
        Ok(())
    }
}
