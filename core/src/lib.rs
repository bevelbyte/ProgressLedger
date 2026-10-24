#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

mod cgpa;
pub mod db;
pub mod native;

/// Rust-visible re-exports so integration tests can exercise the browser
/// manager CRUD without going through napi serialization.
pub use db::browser_manager::{
    add_browser_profile, add_browser_shortcut, delete_browser_profile, delete_browser_shortcut,
    get_browser_profile, list_browser_profiles, list_browser_shortcuts,
    list_pinned_browser_shortcuts, rename_browser_profile, reorder_browser_profiles,
    reorder_browser_shortcuts, set_browser_profile_enabled, toggle_browser_shortcut_pin,
    touch_browser_profile, update_browser_shortcut, BrowserProfileRecord, BrowserShortcutRecord,
};
mod errors;
mod migrations;
pub mod portability;
mod sm2;
pub mod validate;

/// Re-export the Academic Focus signal aggregator so integration tests can
/// exercise the SQL boundary without going through napi serialization.
pub use db::focus_signals::{get_focus_signals, FocusSignals};

use napi_derive::napi;

#[napi]
pub fn ping() -> String {
    "CareerFlow core online".to_string()
}

pub use native::{
    find_window_for_process, focus_hosted_window, get_window_rect_for_handle, host_window,
    inspect_window, resize_hosted_window, show_hosted_window, unhost_window,
};
