#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

mod cgpa;
pub mod db;

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
    "Progress Ledger core online".to_string()
}

