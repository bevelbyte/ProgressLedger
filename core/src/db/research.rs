//! Durable Research sources and kept passages for Progress Ledger-owned browser pages.
//! Deliberately separate from subject-attached academic resources.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;

use crate::db::{to_err, with_db, with_immediate_transaction};
use crate::errors::{coded, codes};
use crate::validate::{required_text, valid_id, MAX_NAME, MAX_URL};

const MAX_PASSAGE: usize = 8_000;

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
    })
}

#[napi]
pub fn save_research_source(profile_id: i32, url: String, title: String) -> Result<ResearchSource> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let (canonical, safe_url, domain) = canonical_research_url(&url)?;
    with_immediate_transaction(|conn| {
        let profile_exists: i32 = conn.query_row("SELECT COUNT(*) FROM profiles WHERE id=?1", params![profile_id], |r| r.get(0)).map_err(to_err)?;
        if profile_exists == 0 { return Err(coded(codes::NOT_OWNED, "Research profile not found")); }
        conn.execute(
            "INSERT INTO research_sources(profile_id,canonical_url,url,title,domain) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(profile_id,canonical_url) DO UPDATE SET title=excluded.title,url=excluded.url,domain=excluded.domain",
            params![profile_id, canonical, safe_url, title, domain],
        ).map_err(to_err)?;
        conn.query_row(
            "SELECT s.id,s.profile_id,s.canonical_url,s.url,s.title,s.domain,s.saved_at,(SELECT COUNT(*) FROM research_captures c WHERE c.profile_id=s.profile_id AND c.source_id=s.id AND c.kind IN ('clip','highlight')) FROM research_sources s WHERE s.profile_id=?1 AND s.canonical_url=?2",
            params![profile_id, canonical], source_from_row,
        ).map_err(to_err)
    })
}

#[napi]
pub fn list_research_sources(profile_id: i32) -> Result<Vec<ResearchSource>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT s.id,s.profile_id,s.canonical_url,s.url,s.title,s.domain,s.saved_at,(SELECT COUNT(*) FROM research_captures c WHERE c.profile_id=s.profile_id AND c.source_id=s.id AND c.kind IN ('clip','highlight')) FROM research_sources s WHERE s.profile_id=?1 ORDER BY s.saved_at DESC,s.id DESC").map_err(to_err)?;
        let rows = stmt.query_map(params![profile_id], source_from_row).map_err(to_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(to_err)
    })
}

#[napi]
pub fn list_research_captures(profile_id: i32) -> Result<Vec<ResearchCapture>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT id,profile_id,source_id,source_url,source_title,page_id,kind,text,created_at FROM research_captures WHERE profile_id=?1 ORDER BY created_at DESC,id DESC").map_err(to_err)?;
        let rows = stmt.query_map(params![profile_id], |r| Ok(ResearchCapture { id:r.get(0)?,profile_id:r.get(1)?,source_id:r.get(2)?,source_url:r.get(3)?,source_title:r.get(4)?,page_id:r.get(5)?,kind:r.get(6)?,text:r.get(7)?,created_at:r.get(8)? })).map_err(to_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(to_err)
    })
}

#[napi]
pub fn count_kept_research_passages(profile_id: i32, url: String) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let (canonical, _, _) = canonical_research_url(&url)?;
    with_db(|conn| conn.query_row("SELECT COUNT(*) FROM research_captures c JOIN research_sources s ON s.id=c.source_id WHERE c.profile_id=?1 AND s.canonical_url=?2 AND c.kind IN ('clip','highlight')", params![profile_id, canonical], |r| r.get(0)).map_err(to_err))
}

#[napi]
pub fn capture_research_passage(profile_id: i32, url: String, title: String, page_id: Option<String>, kind: String, text: String) -> Result<ResearchCapture> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
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
        conn.execute("INSERT INTO research_sources(profile_id,canonical_url,url,title,domain) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(profile_id,canonical_url) DO UPDATE SET title=excluded.title,url=excluded.url,domain=excluded.domain", params![profile_id,canonical,safe_url,title,domain]).map_err(to_err)?;
        let source_id: i32 = conn.query_row("SELECT id FROM research_sources WHERE profile_id=?1 AND canonical_url=?2", params![profile_id,canonical], |r| r.get(0)).map_err(to_err)?;
        conn.execute("INSERT INTO research_captures(profile_id,source_id,source_url,source_title,page_id,kind,text) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(profile_id,source_id,kind,text) DO NOTHING", params![profile_id,source_id,safe_url,title,page_id,kind,text]).map_err(to_err)?;
        conn.query_row("SELECT id,profile_id,source_id,source_url,source_title,page_id,kind,text,created_at FROM research_captures WHERE profile_id=?1 AND source_id=?2 AND kind=?3 AND text=?4", params![profile_id,source_id,kind,text], |r| Ok(ResearchCapture { id:r.get(0)?,profile_id:r.get(1)?,source_id:r.get(2)?,source_url:r.get(3)?,source_title:r.get(4)?,page_id:r.get(5)?,kind:r.get(6)?,text:r.get(7)?,created_at:r.get(8)? })).map_err(to_err)
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
}
