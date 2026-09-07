use crate::retention;
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, params, params_from_iter, types::Value as SqlValue};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, Write},
    path::Path,
    time::Duration,
};
pub type Sql = HashMap<String, String>;
fn s<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .with_context(|| format!("missing import field {key}"))
}
fn yes(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or(false)
}
fn values(row: &Value, keys: &[&str]) -> Result<Vec<SqlValue>> {
    keys.iter()
        .map(|key| match &row[key] {
            Value::Null => Ok(SqlValue::Null),
            Value::String(v) => Ok(SqlValue::Text(v.clone())),
            Value::Number(n) => n
                .as_i64()
                .map(SqlValue::Integer)
                .or_else(|| n.as_f64().map(SqlValue::Real))
                .context("invalid number"),
            Value::Bool(v) => Ok(SqlValue::Integer(i64::from(*v))),
            _ => bail!("invalid import scalar {key}"),
        })
        .collect()
}
fn run(db: &Connection, sql: &Sql, key: &str, vals: &[SqlValue]) -> Result<()> {
    db.prepare_cached(&sql[key])?
        .execute(params_from_iter(vals))?;
    Ok(())
}
fn row(db: &Connection, sql: &Sql, key: &str, v: &Value, keys: &[&str]) -> Result<()> {
    run(db, sql, key, &values(v, keys)?)
}
fn text(s: &str) -> SqlValue {
    SqlValue::Text(s.into())
}
fn clear(db: &Connection, sql: &Sql, h: &Value) -> Result<()> {
    let account = s(h, "accountId")?;
    let local = s(h, "localProfileId")?;
    if !yes(h, "restore") {
        return Ok(());
    }
    if yes(h, "includeTweets") {
        db.execute(
            "delete from sync_cache where cache_key = ?",
            [format!("authored:xurl:{account}:cursor")],
        )?;
        let encoded = s(h, "encodedAccountId")?;
        let pattern = encoded
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        db.execute("delete from sync_cache where cache_key = ? or cache_key like ? escape '\\' or cache_key like ? escape '\\' or cache_key like ? escape '\\'",params![format!("mentions:sync:high-water:v1:mode=xurl:account={encoded}"),format!("mentions:sync:cursor:v2:mode=xurl:account={pattern}:page=%:boundary=%"),format!("mentions:sync:result:v2:mode=xurl:account={pattern}:page=%:boundary=%"),format!("mentions:sync:result:v2:mode=bird:account={pattern}:page=%:boundary=%")])?;
        run(
            db,
            sql,
            "clearSelectedArchiveTweetEdges",
            &[text(account), text(local)],
        )?;
    }
    for (flag, key) in [
        ("includeLikes", "clearSelectedLikes"),
        ("includeBookmarks", "clearSelectedBookmarks"),
    ] {
        if yes(h, flag) {
            run(db, sql, key, &[text(account)])?;
        }
    }
    if ["includeTweets", "includeLikes", "includeBookmarks"]
        .iter()
        .any(|k| yes(h, k))
    {
        for key in [
            "deleteOrphanTweets",
            "deleteOrphanTweetFts",
            "deleteOrphanTweetLinkOccurrences",
            "deleteOrphanTweetSubordinateTombstones",
            "deleteOrphanTweetRevisionChains",
            "deleteOrphanTweetRevisionEdges",
        ] {
            run(db, sql, key, &[])?;
        }
    }
    if yes(h, "includeDirectMessages") {
        for key in [
            "clearDmLinkOccurrences",
            "clearDmFts",
            "clearDmMessages",
            "clearDmConversations",
        ] {
            run(db, sql, key, &[text(account)])?;
        }
    }
    Ok(())
}
fn fts(
    db: &Connection,
    table: &str,
    column: &str,
    ids: &Value,
) -> Result<HashMap<String, Vec<i64>>> {
    let ids: HashSet<&str> = ids
        .as_array()
        .context("missing FTS import identifiers")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let mut out: HashMap<String, Vec<i64>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let mut stmt = db.prepare(&format!("select rowid, {column} from {table}"))?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let id: String = r.get(1)?;
        if ids.contains(id.as_str()) {
            out.entry(id).or_default().push(r.get(0)?);
        }
    }
    Ok(out)
}
fn event(
    db: &Connection,
    sql: &Sql,
    header: &Value,
    direction: &str,
    member: (&str, &str),
    kind: &str,
    snapshot: &str,
) -> Result<()> {
    let account = s(header, "accountId")?;
    let now = s(header, "importedAt")?;
    let (profile, external) = member;
    let hex: String = db.query_row("select lower(hex(randomblob(16)))", [], |r| r.get(0))?;
    let id = format!(
        "follow_event_{}-{}-4{}-a{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..]
    );
    run(
        db,
        sql,
        "insertFollowEvent",
        &[
            text(&id),
            text(account),
            text(direction),
            text(profile),
            text(external),
            text(kind),
            text(now),
            text(snapshot),
        ],
    )
}
fn follows(db: &Connection, sql: &Sql, h: &Value, direction: &str, rows: &Value) -> Result<()> {
    let account = s(h, "accountId")?;
    let now = s(h, "importedAt")?;
    let snapshot = format!("follow_snapshot_archive_{account}_{direction}");
    let restore = yes(h, "restore");
    let count = h[if direction == "followers" {
        "followerEntryCount"
    } else {
        "followingEntryCount"
    }]
    .as_i64()
    .context("missing follow count")?;
    if count == 0 {
        if restore {
            run(
                db,
                sql,
                "deleteArchiveFollowEvents",
                &[
                    text(account),
                    text(direction),
                    text(&snapshot),
                    text(account),
                    text(direction),
                ],
            )?;
            for key in [
                "deleteArchiveFollowSnapshotMembers",
                "deleteArchiveFollowSnapshots",
                "deleteArchiveFollowEdges",
            ] {
                run(db, sql, key, &[text(account), text(direction)])?;
            }
        }
        return Ok(());
    }
    let edges: Vec<(String, String, i64)> = db
        .prepare_cached(&sql["selectFollowEdges"])?
        .query_map(params![account, direction], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let existing: Vec<(String, String)> = db
        .prepare_cached(&sql["selectFollowSnapshotMembers"])?
        .query_map([&snapshot], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut seen = HashSet::new();
    let mut incoming = Vec::new();
    for row in rows.as_array().context("invalid follow rows")? {
        let profile = s(row, "profileId")?;
        if seen.insert(profile.to_owned()) {
            incoming.push((profile.to_owned(), s(row, "externalUserId")?.to_owned()));
        }
    }
    let mut effective = if restore {
        Vec::new()
    } else {
        existing.clone()
    };
    let old: HashSet<&str> = existing.iter().map(|(p, _)| p.as_str()).collect();
    for item in &incoming {
        if restore || !old.contains(item.0.as_str()) {
            effective.push(item.clone());
        }
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FollowMeta<'a> {
        archive_path: &'a str,
        #[serde(rename = "result_count")]
        result_count: usize,
        #[serde(rename = "merged_result_count")]
        merged_result_count: usize,
    }
    let raw = serde_json::to_string(&FollowMeta {
        archive_path: s(h, "archivePath")?,
        result_count: incoming.len(),
        merged_result_count: effective.len(),
    })?;
    run(
        db,
        sql,
        "insertFollowSnapshot",
        &[
            text(&snapshot),
            text(account),
            text(direction),
            text(if restore { "complete" } else { "partial" }),
            SqlValue::Integer(count),
            SqlValue::Integer(effective.len() as i64),
            text(now),
            text(now),
            text(&raw),
        ],
    )?;
    if existing != effective {
        run(db, sql, "deleteFollowSnapshotMembers", &[text(&snapshot)])?;
        for (i, (profile, external)) in effective.iter().enumerate() {
            run(
                db,
                sql,
                "insertFollowSnapshotMember",
                &[
                    text(&snapshot),
                    text(profile),
                    text(external),
                    SqlValue::Integer(i as i64),
                ],
            )?;
        }
    }
    let previous: HashMap<&str, i64> = edges
        .iter()
        .map(|(p, _, current)| (p.as_str(), *current))
        .collect();
    for (profile, external) in &incoming {
        run(
            db,
            sql,
            "insertFollowEdge",
            &[
                text(account),
                text(direction),
                text(profile),
                text(external),
                text(now),
                text(now),
                text(now),
            ],
        )?;
        if previous.get(profile.as_str()).is_none_or(|v| *v == 0) {
            event(
                db,
                sql,
                h,
                direction,
                (profile, external),
                "started",
                &snapshot,
            )?;
        }
    }
    if restore {
        for (profile, external, current) in &edges {
            if *current != 0 && !seen.contains(profile) {
                run(
                    db,
                    sql,
                    "endFollowEdge",
                    &[
                        text(now),
                        text(now),
                        text(account),
                        text(direction),
                        text(profile),
                    ],
                )?;
                event(
                    db,
                    sql,
                    h,
                    direction,
                    (profile, external),
                    "ended",
                    &snapshot,
                )?;
            }
        }
    }
    Ok(())
}

pub fn apply(path: &Path, input: impl BufRead, mut output: impl Write) -> Result<()> {
    let sql: Sql = serde_json::from_str(include_str!("../../src/lib/archive/sql.json"))?;
    let mut lines = input.lines();
    let header: Value = serde_json::from_str(&lines.next().context("missing import header")??)?;
    if header["protocolVersion"] != 1 || header["kind"] != "header" {
        bail!("incompatible import protocol");
    }
    let account = s(&header, "accountId")?;
    let now = s(&header, "importedAt")?;
    let local = s(&header, "localProfileId")?;
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(30))?;
    db.set_prepared_statement_cache_capacity(96);
    db.execute_batch("PRAGMA foreign_keys = ON;")?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    clear(&tx, &sql, &header)?;
    let mut tweets = fts(&tx, "tweets_fts", "tweet_id", &header["tweetIds"])?;
    let mut messages = fts(&tx, "dm_fts", "message_id", &header["dmIds"])?;
    let a = &header["accountPayload"];
    run(
        &tx,
        &sql,
        if yes(&header, "selected") {
            "insertAccountIfMissing"
        } else {
            "insertAccount"
        },
        &[
            text(account),
            text(s(a, "displayName")?),
            text(&format!("@{}", s(a, "username")?)),
            text(s(a, "accountId")?),
            text("archive"),
            text(s(a, "createdAt")?),
        ],
    )?;
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut ended = false;
    for line in lines {
        let value: Value = serde_json::from_str(&line?)?;
        let kind = s(&value, "kind")?;
        let v = &value["row"];
        if ended {
            bail!("data after import end");
        }
        match kind {
            "profile" => row(
                &tx,
                &sql,
                if !yes(&header, "selected") || yes(&header, "includeProfiles") {
                    "insertProfile"
                } else {
                    "insertProfileIfMissing"
                },
                v,
                &[
                    "id",
                    "handle",
                    "displayName",
                    "bio",
                    "followersCount",
                    "followingCount",
                    "publicMetricsJson",
                    "avatarHue",
                    "avatarUrl",
                    "location",
                    "url",
                    "verifiedType",
                    "entitiesJson",
                    "rawJson",
                    "createdAt",
                ],
            )?,
            "tweet" => {
                let id = s(v, "id")?;
                let author = s(v, "authorProfileId")?;
                let preserve = v["deletedAt"].as_str().is_some_and(|v| !v.is_empty())
                    || v["kind"] == "like"
                    || v["kind"] == "bookmark";
                let mut vals = values(
                    v,
                    &[
                        "id",
                        "authorProfileId",
                        "text",
                        "createdAt",
                        "isReplied",
                        "replyToId",
                        "likeCount",
                        "mediaCount",
                        "entitiesJson",
                        "mediaJson",
                        "quotedTweetId",
                        "deletedAt",
                        "deletionSource",
                        "deletionReason",
                    ],
                )?;
                vals.extend([
                    SqlValue::Integer(i64::from(preserve)),
                    SqlValue::Integer(i64::from(preserve)),
                ]);
                run(&tx, &sql, "insertTweet", &vals)?;
                for rowid in tweets.remove(id).unwrap_or_default() {
                    run(&tx, &sql, "deleteTweetFts", &[SqlValue::Integer(rowid)])?;
                }
                for kind in [
                    if v["kind"] == "home" {
                        Some("home")
                    } else {
                        None
                    },
                    if author == local {
                        Some("authored")
                    } else {
                        None
                    },
                ]
                .into_iter()
                .flatten()
                {
                    run(
                        &tx,
                        &sql,
                        "insertTimelineEdge",
                        &[
                            text(account),
                            text(id),
                            text(kind),
                            text(s(v, "createdAt")?),
                            text(s(v, "createdAt")?),
                            text(now),
                        ],
                    )?;
                }
                let (body, deleted, source): (String, Option<String>, Option<String>) = tx
                    .prepare_cached(&sql["selectTweetFtsState"])?
                    .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                if let Some(at) = deleted.as_deref().filter(|s| !s.is_empty()) {
                    let source = source.as_deref().or_else(|| {
                        if v["deletedAt"] == at {
                            v["deletionSource"].as_str()
                        } else {
                            None
                        }
                    });
                    retention::subordinates(&tx, &sql, id, at, source)?;
                } else {
                    run(&tx, &sql, "insertTweetFts", &[text(id), text(&body)])?;
                }
                retention::record(&tx, &sql, v, now)?;
            }
            "collection" => {
                let mut vals = vec![text(account)];
                vals.extend(values(
                    v,
                    &["tweetId", "kind", "collectedAt", "source", "rawJson"],
                )?);
                vals.push(text(now));
                run(&tx, &sql, "insertCollection", &vals)?;
            }
            "conversation" => row(
                &tx,
                &sql,
                "insertConversation",
                v,
                &[
                    "id",
                    "accountId",
                    "participantProfileId",
                    "title",
                    "lastMessageAt",
                    "unreadCount",
                    "needsReply",
                ],
            )?,
            "message" => {
                let id = s(v, "id")?;
                let mut vals = values(
                    v,
                    &[
                        "id",
                        "conversationId",
                        "senderProfileId",
                        "text",
                        "createdAt",
                        "direction",
                    ],
                )?;
                vals.push(SqlValue::Integer(i64::from(v["direction"] == "outbound")));
                vals.extend(values(v, &["mediaCount"])?);
                run(&tx, &sql, "insertMessage", &vals)?;
                for rowid in messages.remove(id).unwrap_or_default() {
                    run(&tx, &sql, "deleteDmFts", &[SqlValue::Integer(rowid)])?;
                }
                run(&tx, &sql, "insertDmFts", &[text(id), text(s(v, "text")?)])?;
                messages.insert(id.into(), vec![tx.last_insert_rowid()]);
            }
            "followers" | "following" => follows(&tx, &sql, &header, kind, v)?,
            "end" => {
                ended = true;
            }
            _ => bail!("unknown import record {kind}"),
        }
        if kind != "end" {
            *counts.entry(kind.into()).or_default() += 1;
        }
    }
    if !ended {
        bail!("incomplete import stream; transaction rolled back");
    }
    for (kind, total) in header["counts"]
        .as_object()
        .context("missing import counts")?
    {
        if counts.get(kind).copied().unwrap_or(0) as u64
            != total.as_u64().context("invalid import count")?
        {
            bail!("import count mismatch for {kind}");
        }
    }
    retention::reconcile(&tx, &sql)?;
    tx.commit()?;
    serde_json::to_writer(
        &mut output,
        &json!({"protocolVersion":1,"committed":true,"counts":counts}),
    )?;
    writeln!(output)?;
    output.flush()?;
    Ok(())
}
