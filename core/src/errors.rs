//! Structured, machine-readable error envelope shared between the Rust core and
//! the Svelte UI.
//!
//! Every `Result`-returning `#[napi]` function should fail with one of these so
//! the renderer's toast layer can map a stable `code` -> friendly, localized
//! copy (instead of dumping a raw Rust string into an `alert()`).
//!
//! The envelope is JSON-encoded into `napi::Error`'s `reason`. On the JS side it
//! arrives as `error.message`; `parseError()` (ui/src/lib/errors.js) extracts and
//! parses it, tolerating Electron's `"Error invoking remote method ...: Error: "`
//! prefix.
//!
//! Wire shape: `{"code":"UIPI_MISMATCH","message":"...","detail":{...}|null}`

use napi::bindgen_prelude::Error;
use serde_json::{json, Value};

/// Stable error codes. Keep in sync with `CODE_COPY` in ui/src/lib/errors.js.
pub mod codes {
    pub const DB_NOT_INITIALIZED: &str = "DB_NOT_INITIALIZED";
    pub const DB_CONSTRAINT: &str = "DB_CONSTRAINT";
    pub const DB_ERROR: &str = "DB_ERROR";
    pub const IO_ERROR: &str = "IO_ERROR";
    pub const INTERNAL: &str = "INTERNAL";
    pub const UNKNOWN_PROFILE: &str = "UNKNOWN_PROFILE";
    pub const UNKNOWN_BROWSER_PROFILE: &str = "UNKNOWN_BROWSER_PROFILE";
    pub const UNKNOWN_SHORTCUT: &str = "UNKNOWN_SHORTCUT";
    pub const NOT_OWNED: &str = "NOT_OWNED";
    pub const INVALID_URL: &str = "INVALID_URL";
    /// A renderer-supplied argument was rejected at the NAPI boundary
    /// (length cap exceeded, null byte present, negative id, etc.).
    pub const INVALID_INPUT: &str = "INVALID_INPUT";
}

/// Build a coded error with no extra detail.
pub fn coded(code: &str, message: impl Into<String>) -> Error {
    coded_detail(code, message, Value::Null)
}

/// Build a coded error carrying a structured `detail` payload (surfaced to the UI
/// for diagnostics — e.g. the two integrity levels involved in a UIPI mismatch).
pub fn coded_detail(code: &str, message: impl Into<String>, detail: Value) -> Error {
    let envelope = json!({
        "code": code,
        "message": message.into(),
        "detail": detail,
    });
    Error::from_reason(envelope.to_string())
}
