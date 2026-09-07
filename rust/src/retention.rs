use crate::import::Sql;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

// Match JavaScript's string order, including supplementary Unicode identifiers.
fn cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn record(db: &Connection, sql: &Sql, tweet: &Value, now: &str) -> Result<()> {
    let id = tweet["id"].as_str().unwrap();
    let mut ids: Vec<String> = Vec::new();
    for v in tweet["editHistoryIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(std::iter::once(id))
    {
        let v = v.trim();
        if !v.is_empty() && !ids.iter().any(|x| x == v) {
            ids.push(v.into());
        }
    }
    let root = ids.first().map(String::as_str).unwrap_or(id);
    for (i, revision) in ids.iter().enumerate() {
        db.prepare_cached(&sql["revisionInsert"])?.execute(params![
            root,
            revision,
            i as i64,
            if revision == id {
                tweet["rawJson"].as_str()
            } else {
                None
            },
            "twitter_archive",
            now
        ])?;
    }
    for edge in ids.windows(2) {
        db.prepare_cached(&sql["revisionEdge"])?.execute(params![
            edge[0],
            edge[1],
            "twitter_archive",
            now
        ])?;
    }
    merge(db, sql, &ids)?;
    if let Some(last) = ids.last() {
        for revision in ids.iter().take(ids.len().saturating_sub(1)) {
            db.prepare_cached(&sql["markSuperseded"])?
                .execute(params![now, now, last, revision])?;
        }
    }
    Ok(())
}

fn merge(db: &Connection, sql: &Sql, ids: &[String]) -> Result<()> {
    let seed = serde_json::to_string(ids)?;
    let nodes: Vec<String> = db
        .prepare_cached(&sql["topology"])?
        .query_map([seed], |r| r.get(1))?
        .collect::<rusqlite::Result<_>>()?;
    if nodes.is_empty() {
        return Ok(());
    }
    let json = serde_json::to_string(&nodes)?;
    let stored: Vec<(String, String)> = db
        .prepare_cached(&sql["storedEdges"])?
        .query_map(params![json, json], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let index: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.as_str(), i))
        .collect();
    let mut edges = vec![Vec::new(); nodes.len()];
    let mut reverse = edges.clone();
    for (a, b) in &stored {
        if a != b
            && let (Some(&a), Some(&b)) = (index.get(a.as_str()), index.get(b.as_str()))
        {
            edges[a].push(b);
            reverse[b].push(a);
        }
    }
    // Iterative Kosaraju preserves cycles without recursion limits.
    let mut visited = vec![false; nodes.len()];
    let mut finished = Vec::new();
    for start in 0..nodes.len() {
        let mut stack = vec![(start, false)];
        while let Some((n, expanded)) = stack.pop() {
            if expanded {
                finished.push(n);
                continue;
            }
            if visited[n] {
                continue;
            }
            visited[n] = true;
            stack.push((n, true));
            for &next in &edges[n] {
                if !visited[next] {
                    stack.push((next, false));
                }
            }
        }
    }
    let mut components = vec![usize::MAX; nodes.len()];
    let mut count = 0;
    for &start in finished.iter().rev() {
        if components[start] != usize::MAX {
            continue;
        }
        let mut stack = vec![start];
        components[start] = count;
        while let Some(n) = stack.pop() {
            for &next in &reverse[n] {
                if components[next] == usize::MAX {
                    components[next] = count;
                    stack.push(next);
                }
            }
        }
        count += 1;
    }
    let mut outgoing = vec![HashSet::new(); count];
    let mut indegree = vec![0usize; count];
    for (a, dest) in edges.iter().enumerate() {
        for &b in dest {
            let (a, b) = (components[a], components[b]);
            if a != b && outgoing[a].insert(b) {
                indegree[b] += 1;
            }
        }
    }
    let mut ready: VecDeque<usize> = (0..count).filter(|&i| indegree[i] == 0).collect();
    let mut ranks = vec![0usize; count];
    while let Some(a) = ready.pop_front() {
        for &b in &outgoing[a] {
            ranks[b] = ranks[b].max(ranks[a] + 1);
            indegree[b] -= 1;
            if indegree[b] == 0 {
                ready.push_back(b);
            }
        }
    }
    let root = (0..nodes.len())
        .min_by(|&a, &b| {
            ranks[components[a]]
                .cmp(&ranks[components[b]])
                .then_with(|| cmp(&nodes[a], &nodes[b]))
        })
        .unwrap();
    for (i, node) in nodes.iter().enumerate() {
        db.prepare_cached(&sql["updateRevision"])?.execute(params![
            nodes[root],
            ranks[components[i]] as i64,
            node
        ])?;
    }
    Ok(())
}

pub fn subordinates(
    db: &Connection,
    sql: &Sql,
    id: &str,
    at: &str,
    source: Option<&str>,
) -> Result<()> {
    let row: Option<(String, Option<String>)> = db
        .prepare_cached("select media_json, quoted_tweet_id from tweets where id = ?")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((media, quote)) = row else {
        return Ok(());
    };
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(Value::Array(items)) = serde_json::from_str(&media) {
        for (i, item) in items.iter().enumerate() {
            if !item.is_object() {
                continue;
            }
            let key = ["media_key", "mediaKey", "id_str", "id", "url"]
                .iter()
                .find_map(|k| item[k].as_str().filter(|x| !x.is_empty()))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("media:{i}"));
            if seen.insert(key.clone()) {
                entries.push(("media", key));
            }
        }
    }
    if let Some(quote) = quote.filter(|v| !v.is_empty()) {
        entries.push(("quote", quote));
    }
    for (kind, key) in entries {
        db.prepare_cached(&sql["subordinateInsert"])?
            .execute(params![id, kind, key, at, source, "parent_tweet_deleted"])?;
    }
    Ok(())
}
#[derive(Clone)]
struct Deletion {
    id: String,
    at: String,
    source: Option<String>,
    reason: Option<String>,
}
fn deleted(db: &Connection) -> Result<Vec<Deletion>> {
    Ok(db.prepare_cached("select id, deleted_at, deletion_source, deletion_reason from tweets where deleted_at is not null")?.query_map([],|r|Ok(Deletion{id:r.get(0)?,at:r.get(1)?,source:r.get(2)?,reason:r.get(3)?}))?.collect::<rusqlite::Result<_>>()?)
}

pub fn reconcile(db: &Connection, sql: &Sql) -> Result<()> {
    db.execute_batch(&sql["supersession"])?;
    let revisions: Vec<(String,String)>=db.prepare_cached("select root_tweet_id, revision_id from tweet_revisions order by root_tweet_id, revision_index, revision_id")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let roots: HashMap<&str, &str> = revisions
        .iter()
        .map(|(root, id)| (id.as_str(), root.as_str()))
        .collect();
    let mut selected: HashMap<&str, Deletion> = HashMap::new();
    for d in deleted(db)? {
        if let Some(&root) = roots.get(d.id.as_str()) {
            let score =
                |d: &Deletion| usize::from(d.source.is_some()) + usize::from(d.reason.is_some());
            let better = selected.get(root).is_none_or(|old| {
                d.at < old.at
                    || (d.at == old.at
                        && (score(&d) > score(old)
                            || (score(&d) == score(old) && cmp(&d.id, &old.id).is_lt())))
            });
            if better {
                selected.insert(root, d);
            }
        }
    }
    for (root, id) in &revisions {
        if let Some(d) = selected.get(root.as_str()) {
            db.prepare_cached("update tweets set deleted_at = ?, deletion_source = ?, deletion_reason = ? where id = ?")?.execute(params![d.at,d.source,d.reason,id])?;
        }
    }
    for d in deleted(db)? {
        subordinates(db, sql, &d.id, &d.at, d.source.as_deref())?;
    }
    db.execute_batch("delete from tweets_fts where tweet_id in (select id from tweets where deleted_at is not null or superseded_at is not null); delete from link_occurrences where source_kind = 'tweet' and source_id in (select id from tweets where deleted_at is not null or superseded_at is not null);")?;
    Ok(())
}
