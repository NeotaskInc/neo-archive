use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{BufRead, Write},
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    #[serde(skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
}
impl Candidate {
    fn key(&self) -> String {
        format!(
            "{}:{}",
            self.app.as_deref().unwrap_or("default"),
            self.username.as_deref().unwrap_or("undefined")
        )
    }
    fn args(&self, args: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(app) = &self.app {
            out.extend(["--app".into(), app.clone()]);
        }
        out.extend(["--auth".into(), "oauth2".into()]);
        if let Some(user) = &self.username {
            out.extend(["--username".into(), user.clone()]);
        }
        out.extend_from_slice(args);
        out
    }
}
fn clean(value: Option<&str>, user: bool) -> Option<String> {
    let value = value?.trim();
    let value = if user {
        value.strip_prefix('@').unwrap_or(value)
    } else {
        value
    };
    if value.is_empty()
        || value.encode_utf16().count() > 128
        || value.chars().any(char::is_whitespace)
        || (user
            && ["-", "–", "(none)", "none", "unknown"].contains(&value.to_lowercase().as_str()))
    {
        None
    } else {
        Some(value.into())
    }
}
fn parse(raw: &str) -> Vec<Candidate> {
    let app_re = Regex::new(r"^\s*(?:▸\s*)?([^\s]+)\s+\[client_id:").unwrap();
    let user_re = Regex::new(r"\boauth2:\s*([^\s]+)").unwrap();
    let mut app = None;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in raw.lines() {
        if let Some(c) = app_re.captures(line) {
            app = clean(Some(&c[1]), false);
            continue;
        }
        if let Some(c) = user_re.captures(line) {
            let candidate = Candidate {
                app: app.clone(),
                username: clean(Some(&c[1]), true),
            };
            if candidate.username.is_some() && seen.insert(candidate.key()) {
                out.push(candidate);
            }
        }
    }
    out
}
struct Bridge<R, W> {
    input: R,
    output: W,
}
impl<R: BufRead, W: Write> Bridge<R, W> {
    fn receive(&mut self) -> Result<Value> {
        let mut line = String::new();
        if self.input.read_line(&mut line)? == 0 {
            bail!("authentication transport closed");
        }
        Ok(serde_json::from_str(&line)?)
    }
    fn send(&mut self, value: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.output, value)?;
        writeln!(self.output)?;
        self.output.flush()?;
        Ok(())
    }
    fn request(&mut self, kind: &str, args: Vec<String>, probe: bool) -> Result<Value> {
        self.send(&json!({"kind":kind,"args":args,"probe":probe}))?;
        self.receive()
    }
    fn candidates(&mut self) -> Result<Vec<Candidate>> {
        let response = self.request("text", vec!["auth".into(), "status".into()], true)?;
        Ok(if response["ok"] == true {
            parse(response["stdout"].as_str().unwrap_or(""))
        } else {
            Vec::new()
        })
    }
    fn find(
        &mut self,
        expected: &str,
        attempted: &HashSet<String>,
        candidates: &[Candidate],
    ) -> Result<Option<Candidate>> {
        for candidate in candidates {
            if attempted.contains(&candidate.key()) {
                continue;
            }
            let response = self.request("json", candidate.args(&["/2/users/me".into()]), true)?;
            let actual = clean(response["payload"]["data"]["username"].as_str(), true);
            if response["ok"] == true
                && actual.is_some_and(|a| a.to_lowercase() == expected.to_lowercase())
            {
                return Ok(Some(candidate.clone()));
            }
        }
        Ok(None)
    }
}
pub fn route(input: impl BufRead, output: impl Write) -> Result<()> {
    let mut bridge = Bridge { input, output };
    let request = bridge.receive()?;
    if request["protocolVersion"] != 1 {
        bail!("incompatible auth protocol");
    }
    let args: Vec<String> = serde_json::from_value(request["args"].clone())?;
    let primary = clean(request["username"].as_str(), true);
    let configured: Option<Candidate> = serde_json::from_value(request["configured"].clone())?;
    let cached: Option<Candidate> = serde_json::from_value(request["cached"].clone())?;
    let mut candidate = Candidate {
        app: None,
        username: primary.clone(),
    };
    let mut cache = None;
    if let Some(configured) = configured {
        candidate = configured;
    } else if let Some(user) = &primary {
        if let Some(cached) = cached {
            candidate = cached;
        } else {
            let candidates = bridge.candidates()?;
            let exact: Vec<&Candidate> = candidates
                .iter()
                .filter(|c| c.username.as_ref() == Some(user))
                .collect();
            if exact.len() == 1 {
                candidate = exact[0].clone();
            } else {
                let verified = bridge.find(user, &HashSet::new(), &candidates)?;
                if let Some(found) = verified {
                    candidate = found;
                } else if let Some(first) = exact.first() {
                    candidate = (*first).clone();
                }
            }
            cache = Some(candidate.clone());
        }
    }
    let response = bridge.request("json", candidate.args(&args), false)?;
    if response["ok"] == true {
        return bridge.send(&json!({"kind":"done","payload":response["payload"],"cache":cache}));
    }
    let error = response["errorId"]
        .as_u64()
        .context("missing auth error identity")?;
    if let Some(user) = &primary {
        let mut attempted = HashSet::from([candidate.key()]);
        if candidate.username.as_ref() != Some(user) {
            attempted.insert(format!("default:{user}"));
        }
        let candidates = bridge.candidates()?;
        if let Some(fallback) = bridge.find(user, &attempted, &candidates)? {
            let retry = bridge.request("json", fallback.args(&args), false)?;
            if retry["ok"] == true {
                return bridge
                    .send(&json!({"kind":"done","payload":retry["payload"],"cache":fallback}));
            }
            // Existing routing retains the original command error even when fallback fails.
            return bridge
                .send(&json!({"kind":"error","errorId":error,"clearCache":true,"cache":fallback}));
        }
        return bridge.send(&json!({"kind":"error","errorId":error,"clearCache":true}));
    }
    bridge.send(&json!({"kind":"error","errorId":error}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_scope_and_labels() {
        let result = parse(
            "▸ one [client_id: xxx]\n oauth2: @alice\n oauth2: alice\n two [client_id: yyy]\n oauth2: alice\n oauth2: unknown\n",
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].app.as_deref(), Some("one"));
        assert_eq!(result[1].app.as_deref(), Some("two"));
    }
    #[test]
    fn verifies_alias_before_fallback() {
        let input=[json!({"protocolVersion":1,"args":["whoami"],"username":"alice","configured":null,"cached":null}),json!({"ok":true,"stdout":"app [client_id: x]\n oauth2: alias"}),json!({"ok":true,"payload":{"data":{"username":"ALICE"}}}),json!({"ok":true,"payload":{"data":{"id":"1"}}})].into_iter().map(|v|v.to_string()+"\n").collect::<String>();
        let mut output = Vec::new();
        route(input.as_bytes(), &mut output).unwrap();
        let lines: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(lines[1]["args"][0], "--app");
        assert_eq!(lines[2]["args"][5], "alias");
        assert_eq!(lines[3]["cache"]["username"], "alias");
    }
}
