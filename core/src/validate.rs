//! Input validation for the NAPI boundary.
//!
//! Every renderer-supplied string or id that reaches the Rust core crosses
//! a trust boundary. The renderer is sandboxed but a compromised renderer
//! (or a bug) should not be able to push unbounded data or orphan-id writes
//! into the database. These helpers are the *cheap* first line of defense
//! — they do not try to validate semantics (the SQL layer enforces FK +
//! unique constraints), only shape: length, control chars, sign.
//!
//! All helpers return `Result<T>` so they compose into any `#[napi]`
//! function with `?`. On failure they emit an `INVALID_INPUT` coded error
//! with a stable message that the UI's error mapping layer recognises.
//!
//! The caps below are chosen so legitimate user input is never rejected:
//! a profile name is at most 80 chars, a note is 200 KB, a URL is 2 KB.
//! A renderer compromise can still try to push 2 GB, but the cap stops it
//! from succeeding.

use napi::bindgen_prelude::Result;

use crate::errors::{coded, codes};

/// Per-field length caps. All are well above the legitimate maximum and
/// well below anything a SQLite text column would struggle with.
pub const MAX_NAME: usize = 200; // subject/semester/track/career title etc.
pub const MAX_SLUG: usize = 80;
pub const MAX_TAG: usize = 60;
pub const MAX_CATEGORY: usize = 40; // deadline category, mistake type
pub const MAX_CODE: usize = 40; // subject code, grade scale code
pub const MAX_URL: usize = 2048;
pub const MAX_TEXT: usize = 100_000; // 100 KB - long notes
pub const MAX_BLOB: usize = 1_000_000; // 1 MB - large note body / card front+back
pub const MAX_PATH: usize = 4096; // filesystem path on win/mac/linux

/// Validate a positive (or zero) row id from the renderer.
///
/// `value <= 0` is rejected because:
///  * Negative ids are not valid SQLite primary keys (they collide with
///    the implicit ROWID auto-increment range which starts at 1).
///  * A negative id reaching a DELETE/UPDATE no-ops but masks a renderer
///    bug; we want the error to surface, not silently fail.
///  * A negative id reaching an INSERT that uses the value as a foreign
///    key would orphan the row (no parent matches). The P1 audit found
///    that the NAPI layer never rejected this — now it does, at the
///    boundary, before the SQL is even prepared.
///
/// Named `valid_id` (not `id`) so call sites whose NAPI function takes a
/// parameter named `id` (which is almost all of them) can import it
/// without it being shadowed.
pub fn valid_id(value: i32, field: &str) -> Result<i32> {
    if value < 0 {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("{field} must be a non-negative integer (got {value})"),
        ));
    }
    Ok(value)
}

/// A profile_id is treated the same as any row id: must be >= 0. The
/// call site is more readable when this is named explicitly.
pub fn profile_id(value: i32) -> Result<i32> {
    valid_id(value, "profile_id")
}

/// Validate a free-form text field: cap length and reject embedded NUL
/// bytes (which would silently truncate a SQLite text column at the NUL
/// rather than fail loudly).
///
/// `None` is allowed and passes through (the caller treats absence as
/// "clear the field"). `Some("")` is also allowed — empty is a valid
/// user intent for optional fields.
pub fn text(value: Option<String>, field: &str, cap: usize) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(s) => {
            if s.len() > cap {
                return Err(coded(
                    codes::INVALID_INPUT,
                    format!("{field} exceeds maximum length of {cap} characters"),
                ));
            }
            if s.contains('\0') {
                return Err(coded(
                    codes::INVALID_INPUT,
                    format!("{field} must not contain null bytes"),
                ));
            }
            Ok(Some(s))
        }
    }
}

/// Validate a required free-form text field. Empty strings are rejected
/// because they almost always indicate a renderer bug or a deliberate
/// garbage write — the UI's own required-field validation should have
/// caught this earlier, but we defend at the boundary.
pub fn required_text(value: String, field: &str, cap: usize) -> Result<String> {
    if value.is_empty() {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("{field} must not be empty"),
        ));
    }
    if value.len() > cap {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("{field} exceeds maximum length of {cap} characters"),
        ));
    }
    if value.contains('\0') {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("{field} must not contain null bytes"),
        ));
    }
    Ok(value)
}

/// Validate an optional free-form text field. Empty strings are allowed
/// (the field is genuinely optional, e.g. mistake tags); oversized or
/// null-byte values are still rejected at the boundary.
pub fn bounded_text(value: String, field: &str, cap: usize) -> Result<String> {
    if value.len() > cap {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("{field} exceeds maximum length of {cap} characters"),
        ));
    }
    if value.contains('\0') {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("{field} must not contain null bytes"),
        ));
    }
    Ok(value)
}

/// Validate a value against a fixed allowlist (e.g. mistake type, career
/// status). The caller passes the allowed set; anything outside it is
/// rejected at the boundary so it never reaches the SQL.
pub fn enum_value(value: String, field: &str, allowed: &[&str]) -> Result<String> {
    if !allowed.iter().any(|a| *a == value) {
        return Err(coded(
            codes::INVALID_INPUT,
            format!(
                "{field} must be one of [{}] (got {:?})",
                allowed.join(", "),
                value
            ),
        ));
    }
    Ok(value)
}

/// Validate a browser profile local id. These ids are minted by the
/// shell as "bp-<uuid>" and are the ONLY browser-profile identifiers
/// that may reach a partition name, a file path, or a SQL row. The
/// "bp-" prefix guarantees the value is never mistaken for an integer
/// when stored in an INTEGER-affinity column (browser_tabs), and the
/// character set (letters, digits, hyphens only) makes it safe in a
/// partition name and a directory name. Anything else — user text,
/// slashes, dots, spaces — is refused at the boundary, so a
/// compromised renderer cannot steer a partition at a path of its
/// choosing.
pub fn valid_browser_profile_id(value: String, field: &str) -> Result<String> {
    // Browser profile ids are bp-<uuid> for persistent profiles and
    // temp-<uuid> for temporary ones. Both are app-generated; the
    // charset/length rules still reject forged ids (../evil, ;rm,
    // persist:evil) exactly as before. Previously only bp- was
    // accepted, so every research call from a temp page failed with
    // INVALID_INPUT (ledger-drawer toasts, capture rejected) even
    // though temp captures are stored with temp- ids.
    let rest = value
        .strip_prefix("bp-")
        .or_else(|| value.strip_prefix("temp-"));
    let ok = value.len() <= 64
        && match rest {
            Some(r) => !r.is_empty() && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            None => false,
        };
    if !ok {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("{field} must be a browser profile id of the form bp-<uuid> or temp-<uuid>"),
        ));
    }
    Ok(value)
}
