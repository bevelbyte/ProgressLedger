//! Durable Research sources and kept passages for Progress Ledger-owned browser pages.
//! Deliberately separate from subject-attached academic resources.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;

use crate::db::{to_err, with_db, with_immediate_transaction};
use crate::errors::{coded, codes};
use crate::validate::{bounded_text, required_text, valid_browser_profile_id, valid_id, MAX_NAME, MAX_URL};

const MAX_PASSAGE: usize = 20_000;
const MAX_SOURCE_TEXT: usize = 200_000;

#[napi(object)]
pub struct ResearchSource {
    pub id: i32,
    pub profile_id: i32,
    pub url: String,
    pub canonical_url: String,
    pub title: String,
    pub domain: String,
    pub saved_at: String,
    pub kept_count: i32,
    pub browser_profile_id: Option<String>,
    pub browser_profile_name: Option<String>,
}

#[napi(object)]
pub struct ResearchCapture {
    pub id: i32,
    pub profile_id: i32,
    pub source_id: i32,
    pub source_url: String,
    pub source_title: String,
    pub page_id: Option<String>,
    pub kind: String,
    pub text: String,
    pub created_at: String,
    pub browser_profile_id: Option<String>,
    pub browser_profile_name: Option<String>,
}

/// Canonical URL identity for the Research ledger. Credentials are rejected;
/// fragments and known credential-like query parameters are never persisted.
pub fn canonical_research_url(input: &str) -> Result<(String, String, String)> {
    let trimmed = required_text(input.to_string(), "url", MAX_URL)?;
    let mut url = url::Url::parse(trimmed.trim())
        .map_err(|_| coded(codes::INVALID_URL, "Research URL must be absolute http(s)"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(coded(codes::INVALID_URL, "Research URL must be absolute http(s)"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(coded(codes::INVALID_URL, "Research URL credentials are not allowed"));
    }
    url.set_fragment(None);
    let sensitive = ["token", "access_token", "auth", "authorization", "key", "api_key", "code", "password", "session", "sessionid", "secret"];
    let kept: Vec<(String, String)> = url.query_pairs()
        .filter(|(key, _)| !sensitive.iter().any(|needle| key.to_ascii_lowercase().contains(needle)))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    if !kept.is_empty() {
        url.query_pairs_mut().extend_pairs(kept.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    let canonical = url.to_string();
    let domain = url.host_str().unwrap_or_default().to_string();
    Ok((canonical.clone(), canonical, domain))
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchSource> {
    Ok(ResearchSource {
        id: row.get(0)?, profile_id: row.get(1)?, canonical_url: row.get(2)?,
        url: row.get(3)?, title: row.get(4)?, domain: row.get(5)?, saved_at: row.get(6)?, kept_count: row.get(7)?,
        browser_profile_id: row.get(8)?, browser_profile_name: row.get(9)?,
    })
}

#[napi]
pub fn save_research_source(profile_id: i32, url: String, title: String, browser_profile_id: Option<String>, browser_profile_name: Option<String>) -> Result<ResearchSource> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let browser_profile_id = match browser_profile_id {
        None => None,
        Some(id) => Some(valid_browser_profile_id(id, "browser_profile_id")?),
    };
    let browser_profile_name = match browser_profile_name {
        None => None,
        Some(name) => Some(bounded_text(name, "browser_profile_name", MAX_NAME)?),
    };
    let (canonical, safe_url, domain) = canonical_research_url(&url)?;
    with_immediate_transaction(|conn| {
        let profile_exists: i32 = conn.query_row("SELECT COUNT(*) FROM profiles WHERE id=?1", params![profile_id], |r| r.get(0)).map_err(to_err)?;
        if profile_exists == 0 { return Err(coded(codes::NOT_OWNED, "Research profile not found")); }
        // Per-browser-profile sources (migration 027): the same URL in
        // two profiles is two rows, so a B capture never overwrites
        // A's row or its text. The conflict target and both lookups
        // below are scoped by browser_profile_id (IS ? matches NULL
        // correctly for manual/pre-3B rows with no browser profile).
        conn.execute(
            "INSERT INTO research_sources(profile_id,canonical_url,url,title,domain,browser_profile_id,browser_profile_name) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO UPDATE SET title=excluded.title,url=excluded.url,domain=excluded.domain,browser_profile_name=excluded.browser_profile_name",
            params![profile_id, canonical, safe_url, title, domain, browser_profile_id, browser_profile_name],
        ).map_err(to_err)?;
        let source_id: i32 = conn.query_row("SELECT id FROM research_sources WHERE profile_id=?1 AND browser_profile_id IS ?2 AND canonical_url=?3", params![profile_id, browser_profile_id, canonical], |r| r.get(0)).map_err(to_err)?;
        conn.execute("DELETE FROM search_index WHERE kind='source' AND source_id=?1", params![source_id]).map_err(to_err)?;
        conn.execute("INSERT INTO search_index(kind,profile_id,source_id,capture_id,title,body) SELECT 'source',s.profile_id,s.id,NULL,s.title,COALESCE(t.text,'') FROM research_sources s LEFT JOIN research_source_texts t ON t.source_id=s.id WHERE s.id=?1", params![source_id]).map_err(to_err)?;
        conn.query_row(
            "SELECT s.id,s.profile_id,s.canonical_url,s.url,s.title,s.domain,s.saved_at,(SELECT COUNT(*) FROM research_captures c WHERE c.profile_id=s.profile_id AND c.source_id=s.id AND c.kind IN ('clip','highlight')),s.browser_profile_id,s.browser_profile_name FROM research_sources s WHERE s.profile_id=?1 AND s.browser_profile_id IS ?2 AND s.canonical_url=?3",
            params![profile_id, browser_profile_id, canonical], source_from_row,
        ).map_err(to_err)
    })
}

#[napi]
pub fn list_research_sources(profile_id: i32) -> Result<Vec<ResearchSource>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT s.id,s.profile_id,s.canonical_url,s.url,s.title,s.domain,s.saved_at,(SELECT COUNT(*) FROM research_captures c WHERE c.profile_id=s.profile_id AND c.source_id=s.id AND c.kind IN ('clip','highlight')),s.browser_profile_id,s.browser_profile_name FROM research_sources s WHERE s.profile_id=?1 ORDER BY s.saved_at DESC,s.id DESC").map_err(to_err)?;
        let rows = stmt.query_map(params![profile_id], source_from_row).map_err(to_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(to_err)
    })
}

#[napi]
pub fn list_research_captures(profile_id: i32) -> Result<Vec<ResearchCapture>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT id,profile_id,source_id,source_url,source_title,page_id,kind,text,created_at,browser_profile_id,browser_profile_name FROM research_captures WHERE profile_id=?1 ORDER BY created_at DESC,id DESC").map_err(to_err)?;
        let rows = stmt.query_map(params![profile_id], |r| Ok(ResearchCapture { id:r.get(0)?,profile_id:r.get(1)?,source_id:r.get(2)?,source_url:r.get(3)?,source_title:r.get(4)?,page_id:r.get(5)?,kind:r.get(6)?,text:r.get(7)?,created_at:r.get(8)?,browser_profile_id:r.get(9)?,browser_profile_name:r.get(10)? })).map_err(to_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(to_err)
    })
}

#[napi]
pub fn count_kept_research_passages(profile_id: i32, url: String, browser_profile_id: Option<String>) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let (canonical, _, _) = canonical_research_url(&url)?;
    // Kept count is per BROWSER profile: the old query summed captures
    // across every browser profile of the workspace, so the browser
    // bar showed other profiles' passages as this page's own. The
    // caller passes the active page's browser profile id (None only
    // for manual, non-browser saves).
    // Temporary profiles use temp-<uuid> ids; the shared validator
    // accepts both prefixes (see valid_browser_profile_id).
    let browser_profile_id = match browser_profile_id {
        None => None,
        Some(id) => Some(valid_browser_profile_id(id, "browser_profile_id")?),
    };
    with_db(|conn| conn.query_row("SELECT COUNT(*) FROM research_captures c JOIN research_sources s ON s.id=c.source_id WHERE c.profile_id=?1 AND s.canonical_url=?2 AND c.browser_profile_id IS ?3 AND s.browser_profile_id IS ?3 AND c.kind IN ('clip','highlight')", params![profile_id, canonical, browser_profile_id], |r| r.get(0)).map_err(to_err))
}

#[napi]
pub fn capture_research_passage(profile_id: i32, url: String, title: String, page_id: Option<String>, kind: String, text: String, browser_profile_id: Option<String>, browser_profile_name: Option<String>) -> Result<ResearchCapture> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let browser_profile_id = match browser_profile_id {
        None => None,
        Some(id) => Some(valid_browser_profile_id(id, "browser_profile_id")?),
    };
    let browser_profile_name = match browser_profile_name {
        None => None,
        Some(name) => Some(bounded_text(name, "browser_profile_name", MAX_NAME)?),
    };
    let text = required_text(text.trim().to_string(), "passage", MAX_PASSAGE)?;
    if !matches!(kind.as_str(), "clip" | "highlight" | "extraction") {
        return Err(coded(codes::INVALID_INPUT, "Unsupported Research capture kind"));
    }
    if let Some(ref id) = page_id {
        if id.len() > 80 || !id.starts_with("bp-") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(coded(codes::INVALID_INPUT, "Invalid browser page identity"));
        }
    }
    let (canonical, safe_url, domain) = canonical_research_url(&url)?;
    with_immediate_transaction(|conn| {
        let exists: i32 = conn.query_row("SELECT COUNT(*) FROM profiles WHERE id=?1", params![profile_id], |r| r.get(0)).map_err(to_err)?;
        if exists == 0 { return Err(coded(codes::NOT_OWNED, "Research profile not found")); }
        conn.execute("INSERT INTO research_sources(profile_id,canonical_url,url,title,domain,browser_profile_id,browser_profile_name) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO UPDATE SET title=excluded.title,url=excluded.url,domain=excluded.domain,browser_profile_name=excluded.browser_profile_name", params![profile_id,canonical,safe_url,title,domain,browser_profile_id,browser_profile_name]).map_err(to_err)?;
        let source_id: i32 = conn.query_row("SELECT id FROM research_sources WHERE profile_id=?1 AND browser_profile_id IS ?2 AND canonical_url=?3", params![profile_id,browser_profile_id,canonical], |r| r.get(0)).map_err(to_err)?;
        conn.execute("INSERT INTO research_captures(profile_id,source_id,source_url,source_title,page_id,kind,text,browser_profile_id,browser_profile_name) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(profile_id,source_id,kind,text) DO NOTHING", params![profile_id,source_id,safe_url,title,page_id,kind,text,browser_profile_id,browser_profile_name]).map_err(to_err)?;
        let cap = conn.query_row("SELECT id,profile_id,source_id,source_url,source_title,page_id,kind,text,created_at,browser_profile_id,browser_profile_name FROM research_captures WHERE profile_id=?1 AND source_id=?2 AND kind=?3 AND text=?4", params![profile_id,source_id,kind,text], |r| Ok(ResearchCapture { id:r.get(0)?,profile_id:r.get(1)?,source_id:r.get(2)?,source_url:r.get(3)?,source_title:r.get(4)?,page_id:r.get(5)?,kind:r.get(6)?,text:r.get(7)?,created_at:r.get(8)?,browser_profile_id:r.get(9)?,browser_profile_name:r.get(10)? })).map_err(to_err)?;
        conn.execute("DELETE FROM search_index WHERE kind='passage' AND capture_id=?1", params![cap.id]).map_err(to_err)?;
        conn.execute("INSERT INTO search_index(kind,profile_id,source_id,capture_id,title,body) VALUES('passage',?1,?2,?3,?4,?5)", params![profile_id,source_id,cap.id,title,text]).map_err(to_err)?;
        Ok(cap)
    })
}

#[napi(object)]
pub struct ResearchSearchHit {
    pub kind: String,
    pub source_id: i32,
    pub capture_id: Option<i32>,
    pub title: String,
    pub snippet: String,
}

#[napi(object)]
pub struct BrowserTab {
    pub id: i32,
    pub profile_id: i32,
    pub browser_profile_id: String,
    pub position: i32,
    pub url: String,
    pub title: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

fn tab_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrowserTab> {
    let active: i32 = row.get(6)?;
    Ok(BrowserTab {
        id: row.get(0)?, profile_id: row.get(1)?, browser_profile_id: row.get(2)?,
        position: row.get(3)?, url: row.get(4)?, title: row.get(5)?, is_active: active != 0,
        created_at: row.get(7)?, updated_at: row.get(8)?,
    })
}

/// Tab URLs are stored exactly (fragments and query strings matter for a
/// restore), never canonicalized — but they must still be absolute http(s)
/// with no credentials, matching the browser's own navigation policy.
fn valid_tab_url(input: &str) -> Result<String> {
    let trimmed = required_text(input.to_string(), "url", 4096)?;
    // A fresh blank page is a legitimate tab URL: it has no host and no
    // credentials, and it must be storable so a blank tab restores as
    // blank instead of failing its row write (Iso12: tab-state-failed).
    if trimmed.trim() == "about:blank" {
        return Ok(trimmed);
    }
    let url = url::Url::parse(trimmed.trim())
        .map_err(|_| coded(codes::INVALID_URL, "Tab URL must be absolute http(s)"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(coded(codes::INVALID_URL, "Tab URL must be absolute http(s)"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(coded(codes::INVALID_URL, "Tab URL credentials are not allowed"));
    }
    Ok(trimmed)
}

fn short_title(title: String) -> String {
    if title.chars().count() > 500 { title.chars().take(500).collect() } else { title }
}

/// Save a captured page's full text plus its snapshot metadata. The shell
/// writes the snapshot file first and passes only the file NAME (never a
/// path) and the SHA-256 it computed; this function stores the metadata
/// and the FTS row atomically with the text. Text over the cap is
/// refused, not silently cut — the shell truncates first and sets the
/// truncated flag, so an over-cap value here means the caps were bypassed.
#[napi]
pub fn save_research_source_content(profile_id: i32, source_id: i32, text: String, content_file: Option<String>, content_sha256: Option<String>, text_truncated: bool) -> Result<ResearchSource> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let source_id = valid_id(source_id, "source_id")?;
    let text = required_text(text.trim().to_string(), "source text", MAX_SOURCE_TEXT)?;
    if let Some(ref file) = content_file {
        if file.is_empty() || file.contains('/') || file.contains('\\') || !file.ends_with(".html") {
            return Err(coded(codes::INVALID_INPUT, "Snapshot file name must be a plain .html name"));
        }
    }
    if let Some(ref hash) = content_sha256 {
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(coded(codes::INVALID_INPUT, "Snapshot SHA-256 must be 64 hex characters"));
        }
    }
    let text_length = text.chars().count() as i32;
    let truncated: i32 = if text_truncated { 1 } else { 0 };
    with_immediate_transaction(|conn| {
        let title: String = conn.query_row("SELECT title FROM research_sources WHERE id=?1 AND profile_id=?2", params![source_id, profile_id], |r| r.get(0)).map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => coded(codes::NOT_OWNED, "Research source not found"),
            _ => to_err(e),
        })?;
        conn.execute("INSERT INTO research_source_texts(source_id,text) VALUES(?1,?2) ON CONFLICT(source_id) DO UPDATE SET text=excluded.text", params![source_id, text]).map_err(to_err)?;
        conn.execute("UPDATE research_sources SET content_file=?1,content_sha256=?2,text_length=?3,text_truncated=?4 WHERE id=?5 AND profile_id=?6", params![content_file, content_sha256, text_length, truncated, source_id, profile_id]).map_err(to_err)?;
        conn.execute("DELETE FROM search_index WHERE kind='source' AND source_id=?1", params![source_id]).map_err(to_err)?;
        conn.execute("INSERT INTO search_index(kind,profile_id,source_id,capture_id,title,body) VALUES('source',?1,?2,NULL,?3,?4)", params![profile_id, source_id, title, text]).map_err(to_err)?;
        conn.query_row(
            "SELECT s.id,s.profile_id,s.canonical_url,s.url,s.title,s.domain,s.saved_at,(SELECT COUNT(*) FROM research_captures c WHERE c.profile_id=s.profile_id AND c.source_id=s.id AND c.kind IN ('clip','highlight')),s.browser_profile_id,s.browser_profile_name FROM research_sources s WHERE s.id=?1 AND s.profile_id=?2",
            params![source_id, profile_id], source_from_row,
        ).map_err(to_err)
    })
}

/// Delete a source and everything under it (passages, full text, FTS
/// rows). Returns the snapshot file NAME so the shell can unlink the
/// file after this commit; None means there was no snapshot.
#[napi]
pub fn delete_research_source(profile_id: i32, source_id: i32) -> Result<Option<String>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let source_id = valid_id(source_id, "source_id")?;
    with_immediate_transaction(|conn| {
        let content_file: Option<String> = conn.query_row("SELECT content_file FROM research_sources WHERE id=?1 AND profile_id=?2", params![source_id, profile_id], |r| r.get(0)).map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => coded(codes::NOT_OWNED, "Research source not found"),
            _ => to_err(e),
        })?;
        conn.execute("DELETE FROM search_index WHERE source_id=?1", params![source_id]).map_err(to_err)?;
        conn.execute("DELETE FROM research_source_texts WHERE source_id=?1", params![source_id]).map_err(to_err)?;
        conn.execute("DELETE FROM research_captures WHERE source_id=?1", params![source_id]).map_err(to_err)?;
        conn.execute("DELETE FROM research_sources WHERE id=?1 AND profile_id=?2", params![source_id, profile_id]).map_err(to_err)?;
        Ok(content_file)
    })
}

/// Delete one kept passage and its FTS row.
#[napi]
pub fn delete_research_passage(profile_id: i32, capture_id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let capture_id = valid_id(capture_id, "capture_id")?;
    with_immediate_transaction(|conn| {
        let exists: i32 = conn.query_row("SELECT COUNT(*) FROM research_captures WHERE id=?1 AND profile_id=?2", params![capture_id, profile_id], |r| r.get(0)).map_err(to_err)?;
        if exists == 0 { return Err(coded(codes::NOT_OWNED, "Research passage not found")); }
        conn.execute("DELETE FROM search_index WHERE kind='passage' AND capture_id=?1", params![capture_id]).map_err(to_err)?;
        conn.execute("DELETE FROM research_captures WHERE id=?1 AND profile_id=?2", params![capture_id, profile_id]).map_err(to_err)?;
        Ok(())
    })
}

/// Build a short snippet around the first query term, marking every
/// term occurrence with <b>...</b> (the same markers the UI already parses).
/// The window is about 240 characters centred on the first match, with
/// "..." where text was cut. Marking runs only on ASCII windows:
/// lowercasing can shift byte offsets in other scripts, and a wrong
/// marker is worse than none.
fn make_snippet(text: &str, terms: &[String]) -> String {
    if text.is_empty() || terms.is_empty() {
        return String::new();
    }
    let lowered = text.to_lowercase();
    let mut first: Option<usize> = None;
    for term in terms {
        if term.is_empty() { continue; }
        if let Some(pos) = lowered.find(&term.to_lowercase()) {
            first = Some(match first { Some(p) => p.min(pos), None => pos });
        }
    }
    let mut start = first.map(|pos| pos.saturating_sub(60)).unwrap_or(0);
    while start > 0 && !text.is_char_boundary(start) { start -= 1; }
    let mut end = (start + 240).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) { end += 1; }
    let window = &text[start..end];
    let mut out = String::new();
    if start > 0 { out.push_str("..."); }
    if window.is_ascii() {
        // ASCII lowercasing is exactly 1:1 in bytes, so byte indices in
        // the lowered window line up with the original window.
        let window_lower = window.to_lowercase();
        let mut ordered: Vec<&String> = terms.iter().filter(|t| !t.is_empty()).collect();
        ordered.sort_by(|a, b| b.len().cmp(&a.len()));
        let mut i = 0;
        while i < window.len() {
            let mut matched: Option<usize> = None;
            for term in &ordered {
                let tl = term.to_lowercase();
                if window_lower[i..].starts_with(&tl) { matched = Some(tl.len()); break; }
            }
            if let Some(len) = matched {
                out.push_str("<b>");
                out.push_str(&window[i..i + len]);
                out.push_str("</b>");
                i += len;
            } else {
                let ch = window[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    } else {
        out.push_str(window);
    }
    if end < text.len() { out.push_str("..."); }
    out
}

/// Full-text search over sources and passages (one index, best match
/// first). Each term is quoted so operators in the user's words are
/// literal, and the query is a bound parameter, never interpolated.
/// Snippets are computed here in Rust, not by SQLite's snippet():
/// snippet() fails to parse in this build's bundled SQLite — observed
/// twice (syntax error at the ellipsis argument, first with a Unicode
/// ellipsis, then with plain ASCII dots) — while a plain SELECT with
/// MATCH parses fine. Computing the snippet here is also what lets the
/// UI keep its <b> marker contract unchanged.
#[napi]
pub fn search_research(profile_id: i32, query: String, limit: Option<i32>) -> Result<Vec<ResearchSearchHit>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() { return Ok(vec![]); }
    let terms: Vec<String> = trimmed.split_whitespace().map(|t| t.to_string()).collect();
    if terms.is_empty() { return Ok(vec![]); }
    let fts_query = terms.iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>().join(" AND ");
    let limit = limit.unwrap_or(50).clamp(1, 100);
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT kind,source_id,capture_id,title,body FROM search_index WHERE profile_id=?1 AND search_index MATCH ?2 ORDER BY rank LIMIT ?3").map_err(to_err)?;
        let rows = stmt.query_map(params![profile_id, fts_query, limit], |r| {
            let kind: String = r.get(0)?;
            let source_id: i32 = r.get(1)?;
            let capture_id: Option<i32> = r.get(2)?;
            let title: String = r.get(3)?;
            let body: String = r.get(4)?;
            let haystack = if body.is_empty() { title.clone() } else { body };
            Ok(ResearchSearchHit { kind, source_id, capture_id, title, snippet: make_snippet(&haystack, &terms) })
        }).map_err(to_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(to_err)
    })
}

#[napi]
pub fn save_browser_tab(profile_id: i32, browser_profile_id: String, position: i32, url: String, title: String, is_active: bool) -> Result<BrowserTab> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let browser_profile_id = valid_browser_profile_id(browser_profile_id, "browser_profile_id")?;
    if position < 0 { return Err(coded(codes::INVALID_INPUT, "Tab position must not be negative")); }
    let url = valid_tab_url(&url)?;
    let title = short_title(title);
    let active: i32 = if is_active { 1 } else { 0 };
    with_db(|conn| {
        let exists: i32 = conn.query_row("SELECT COUNT(*) FROM profiles WHERE id=?1", params![profile_id], |r| r.get(0)).map_err(to_err)?;
        if exists == 0 { return Err(coded(codes::NOT_OWNED, "Browser tab profile not found")); }
        conn.execute("INSERT INTO browser_tabs(profile_id,browser_profile_id,position,url,title,is_active) VALUES(?1,?2,?3,?4,?5,?6)", params![profile_id, browser_profile_id, position, url, title, active]).map_err(to_err)?;
        conn.query_row("SELECT id,profile_id,browser_profile_id,position,url,title,is_active,created_at,updated_at FROM browser_tabs WHERE rowid=last_insert_rowid()", [], tab_from_row).map_err(to_err)
    })
}

#[napi]
pub fn update_browser_tab(tab_id: i32, url: String, title: String) -> Result<BrowserTab> {
    let tab_id = valid_id(tab_id, "tab_id")?;
    let url = valid_tab_url(&url)?;
    let title = short_title(title);
    with_db(|conn| {
        let changed = conn.execute("UPDATE browser_tabs SET url=?1,title=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?3", params![url, title, tab_id]).map_err(to_err)?;
        if changed == 0 { return Err(coded(codes::NOT_OWNED, "Browser tab not found")); }
        conn.query_row("SELECT id,profile_id,browser_profile_id,position,url,title,is_active,created_at,updated_at FROM browser_tabs WHERE id=?1", params![tab_id], tab_from_row).map_err(to_err)
    })
}

#[napi]
pub fn delete_browser_tab(tab_id: i32) -> Result<()> {
    let tab_id = valid_id(tab_id, "tab_id")?;
    with_db(|conn| {
        conn.execute("DELETE FROM browser_tabs WHERE id=?1", params![tab_id]).map_err(to_err)?;
        Ok(())
    })
}

#[napi]
pub fn list_browser_tabs(profile_id: i32) -> Result<Vec<BrowserTab>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT id,profile_id,browser_profile_id,position,url,title,is_active,created_at,updated_at FROM browser_tabs WHERE profile_id=?1 ORDER BY position ASC,id ASC").map_err(to_err)?;
        let rows = stmt.query_map(params![profile_id], tab_from_row).map_err(to_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(to_err)
    })
}

#[cfg(test)]
mod tests {
    use super::canonical_research_url;
    #[test]
    fn canonical_url_drops_fragment_and_sensitive_query_values() {
        let (key, url, domain) = canonical_research_url("HTTPS://Example.COM:443/a#part?x=1").unwrap();
        assert_eq!(key, "https://example.com/a");
        assert_eq!(url, key);
        assert_eq!(domain, "example.com");
        let (_, safe, _) = canonical_research_url("https://example.com/a?token=secret&topic=rust").unwrap();
        assert_eq!(safe, "https://example.com/a?topic=rust");
        assert!(canonical_research_url("https://user:pass@example.com").is_err());
    }

    #[test]
    fn research_text_search_tabs_round_trip() {
        // The pool holds the file open, so the temp database is left in
        // %TEMP% (small, per-process unique). test-threads=1 keeps the
        // global pool serial, and init_db runs first, so this test always
        // uses its own database regardless of run order.
        let path = std::env::temp_dir().join(format!("pl-v2-test-research-{}.db", std::process::id()));
        crate::db::init_db(path.to_string_lossy().into_owned()).expect("init test db");
        let profile = crate::db::add_profile("Research Test".to_string(), "research-test".to_string()).expect("profile");
        let pid = profile.id;
        let src = super::save_research_source(pid, "https://example.com/a?token=x".to_string(), "Example A".to_string(), Some("bp-test-profile".to_string()), Some("Test Profile".to_string())).expect("source");
        assert_eq!(src.browser_profile_id.as_deref(), Some("bp-test-profile"));
        assert_eq!(src.browser_profile_name.as_deref(), Some("Test Profile"));
        assert_eq!(src.domain, "example.com");
        let content = super::save_research_source_content(pid, src.id, "the quick brown fox jumps".to_string(), Some(format!("{}.html", src.id)), Some("a".repeat(64)), false).expect("content");
        assert_eq!(content.id, src.id);
        let cap = super::capture_research_passage(pid, "https://example.com/a".to_string(), "Example A".to_string(), Some("bp-1".to_string()), "extraction".to_string(), "a kept passage about the fox".to_string(), Some("bp-test-profile".to_string()), Some("Test Profile".to_string())).expect("passage");
        assert_eq!(cap.browser_profile_id.as_deref(), Some("bp-test-profile"));
        let hits = super::search_research(pid, "fox".to_string(), None).expect("search");
        assert!(hits.iter().any(|h| h.kind == "source" && h.source_id == src.id), "source hit missing");
        assert!(hits.iter().any(|h| h.kind == "passage" && h.capture_id == Some(cap.id)), "passage hit missing");
        assert!(hits.iter().any(|h| h.snippet.contains("<b>fox</b>")), "snippet must mark the matched term");
        assert!(!hits.is_empty() && hits.len() <= 50);
        let big = "x".repeat(20_000);
        let _ = super::capture_research_passage(pid, "https://example.com/b".to_string(), "Example B".to_string(), None, "clip".to_string(), big, None, None).expect("20k passage ok");
        super::delete_research_passage(pid, cap.id).expect("delete passage");
        let hits2 = super::search_research(pid, "kept passage about the fox".to_string(), None).expect("search2");
        assert!(!hits2.iter().any(|h| h.capture_id == Some(cap.id)), "deleted passage still searchable");
        let tab = super::save_browser_tab(pid, "bp-test-profile".to_string(), 0, "https://example.com/a".to_string(), "Example A".to_string(), true).expect("tab");
        assert_eq!(tab.browser_profile_id, "bp-test-profile");
        let tabs = super::list_browser_tabs(pid).expect("list tabs");
        assert_eq!(tabs.len(), 1);
        assert!(tabs[0].is_active);
        let upd = super::update_browser_tab(tab.id, "https://example.com/c".to_string(), "Example C".to_string()).expect("update tab");
        assert_eq!(upd.url, "https://example.com/c");
        super::delete_browser_tab(tab.id).expect("delete tab");
        assert!(super::list_browser_tabs(pid).expect("list2").is_empty());
        let file = super::delete_research_source(pid, src.id).expect("delete source");
        assert_eq!(file, Some(format!("{}.html", src.id)));
        let remaining = super::list_research_sources(pid).expect("list sources");
        assert!(!remaining.iter().any(|s| s.id == src.id), "deleted source still listed");
        let hits3 = super::search_research(pid, "fox".to_string(), None).expect("search3");
        assert!(hits3.is_empty(), "source FTS rows must go with the source");
    }

    #[test]
    fn same_url_in_two_browser_profiles_is_two_sources_with_two_texts() {
        // Migration 027: a second profile capturing the same URL must
        // NOT overwrite the first profile's row or its text (Iso13).
        let path = std::env::temp_dir().join(format!("pl-v2-test-research-per-profile-{}.db", std::process::id()));
        crate::db::init_db(path.to_string_lossy().into_owned()).expect("init test db");
        let profile = crate::db::add_profile("Per Profile Test".to_string(), "per-profile-test".to_string()).expect("profile");
        let pid = profile.id;
        let url = "https://example.com/state".to_string();
        let src_a = super::save_research_source(pid, url.clone(), "State".to_string(), Some("bp-profile-a".to_string()), Some("Profile A".to_string())).expect("source A");
        let src_b = super::save_research_source(pid, url.clone(), "State".to_string(), Some("bp-profile-b".to_string()), Some("Profile B".to_string())).expect("source B");
        assert_ne!(src_a.id, src_b.id, "same URL in A and B must be two rows");
        assert_eq!(src_a.browser_profile_id.as_deref(), Some("bp-profile-a"));
        assert_eq!(src_b.browser_profile_id.as_deref(), Some("bp-profile-b"));
        super::save_research_source_content(pid, src_a.id, "cookie=A ls=A".to_string(), None, None, false).expect("content A");
        super::save_research_source_content(pid, src_b.id, "cookie= ls=".to_string(), None, None, false).expect("content B");
        let listed = super::list_research_sources(pid).expect("list");
        assert_eq!(listed.iter().filter(|s| s.canonical_url == "https://example.com/state").count(), 2);
        let cap_b = super::capture_research_passage(pid, url.clone(), "State".to_string(), Some("bp-2".to_string()), "extraction".to_string(), "B passage".to_string(), Some("bp-profile-b".to_string()), Some("Profile B".to_string())).expect("passage B");
        assert_eq!(cap_b.source_id, src_b.id, "B passage must attach to B source, not A source");
        // Manual (no browser profile) saves of the same URL must still
        // dedupe to one row (partial-index NULL case, shell test).
        let manual_url = "https://example.com/manual".to_string();
        let m1 = super::save_research_source(pid, manual_url.clone(), "Manual".to_string(), None, None).expect("manual source");
        let _ = super::capture_research_passage(pid, manual_url.clone(), "Manual".to_string(), None, "clip".to_string(), "manual passage".to_string(), None, None).expect("manual passage");
        let listed2 = super::list_research_sources(pid).expect("list2");
        assert_eq!(listed2.iter().filter(|s| s.canonical_url == "https://example.com/manual").count(), 1);
        assert!(listed2.iter().any(|s| s.id == m1.id), "manual capture must reuse the manual source row");
    }
}
