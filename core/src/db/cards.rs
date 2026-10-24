//! Recall Deck: SM-2 Spaced Repetition flashcard system.
//!
//! This module implements the SuperMemo 2 (SM-2) algorithm for spaced repetition,
//! helping students memorize formulas, derivations, and key concepts efficiently.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{required_text, valid_id, MAX_BLOB};

fn today_date() -> String {
    if std::env::var_os("PROGRESSLEDGER_V2_E2E").is_some() {
        chrono::Utc::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string()
    } else {
        chrono::Local::now()
            .naive_local()
            .date()
            .format("%Y-%m-%d")
            .to_string()
    }
}

#[napi(object)]
pub struct Card {
    pub id: i32,
    pub subject_id: i32,
    pub subject_name: String,
    pub front: String,
    pub back: String,
    pub ease_factor: f64,
    pub interval: i32,
    pub repetitions: i32,
    pub due_date: String,
    pub created_at: String,
    pub last_reviewed: Option<String>,
}

#[napi(object)]
pub struct ReviewStats {
    pub due_today: i32,
    pub reviewed_today: i32,
    pub total_cards: i32,
    pub streak: i32,
}

/// Create a flashcard in the given subject, owned by the given profile.
/// `profile_id` is the caller's profile; we verify the subject belongs to
/// it before writing, so a renderer compromise cannot create cards in
/// another profile's subjects.
#[napi]
pub fn create_card(profile_id: i32, subject_id: i32, front: String, back: String) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let front = required_text(front, "front", MAX_BLOB)?;
    let back = required_text(back, "back", MAX_BLOB)?;
    with_db(|conn| {
        // Defense-in-depth: even though the schema has FKs to subjects
        // and the renderer is the only writer, we re-confirm the subject
        // belongs to this profile before inserting. A renderer that
        // supplies another profile's subject_id is rejected here.
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM subjects sub
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE sub.id = ?1 AND t.profile_id = ?2",
                params![subject_id, profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Subject does not belong to this profile",
            ));
        }

        let today = today_date();

        conn.execute(
            "INSERT INTO cards (subject_id, front, back, ease_factor, interval_days, repetitions, due_date)
             VALUES (?1, ?2, ?3, 2.5, 0, 0, ?4)",
            params![subject_id, front, back, today],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_due_cards(profile_id: i32) -> Result<Vec<Card>> {
    with_db(|conn| {
        let today = today_date();

        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.subject_id, s.name, c.front, c.back,
                        c.ease_factor, c.interval_days, c.repetitions, c.due_date, c.created_at, c.last_reviewed
                 FROM cards c
                 JOIN subjects s ON s.id = c.subject_id
                 JOIN milestones m ON m.id = s.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1 AND c.due_date <= ?2
                 ORDER BY c.due_date ASC, c.id ASC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, today], |row| {
                Ok(Card {
                    id: row.get(0)?,
                    subject_id: row.get(1)?,
                    subject_name: row.get(2)?,
                    front: row.get(3)?,
                    back: row.get(4)?,
                    ease_factor: row.get(5)?,
                    interval: row.get(6)?,
                    repetitions: row.get(7)?,
                    due_date: row.get(8)?,
                    created_at: row.get(9)?,
                    last_reviewed: row.get(10)?,
                })
            })
            .map_err(to_err)?;
        let mut cards = Vec::new();
        for row in rows {
            cards.push(row.map_err(to_err)?);
        }
        Ok(cards)
    })
}

#[napi]
pub fn get_all_cards(profile_id: i32) -> Result<Vec<Card>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.subject_id, s.name, c.front, c.back,
                        c.ease_factor, c.interval_days, c.repetitions, c.due_date, c.created_at, c.last_reviewed
                 FROM cards c
                 JOIN subjects s ON s.id = c.subject_id
                 JOIN milestones m ON m.id = s.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1
                 ORDER BY c.due_date ASC, c.id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], |row| {
                Ok(Card {
                    id: row.get(0)?,
                    subject_id: row.get(1)?,
                    subject_name: row.get(2)?,
                    front: row.get(3)?,
                    back: row.get(4)?,
                    ease_factor: row.get(5)?,
                    interval: row.get(6)?,
                    repetitions: row.get(7)?,
                    due_date: row.get(8)?,
                    created_at: row.get(9)?,
                    last_reviewed: row.get(10)?,
                })
            })
            .map_err(to_err)?;
        let mut cards = Vec::new();
        for row in rows {
            cards.push(row.map_err(to_err)?);
        }
        Ok(cards)
    })
}

/// Review a card (SM-2 update). `profile_id` is the caller's profile; the
/// function refuses to update cards owned by another profile.
#[napi]
pub fn review_card(profile_id: i32, card_id: i32, quality: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let card_id = valid_id(card_id, "card_id")?;
    with_db(|conn| {
        assert_card_owned_by(conn, profile_id, card_id)?;
        // Get current card state
        let (ef, interval, reps): (f64, i32, i32) = conn
            .query_row(
                "SELECT ease_factor, interval_days, repetitions FROM cards WHERE id = ?1",
                params![card_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(to_err)?;

        // Apply SM-2 algorithm
        let (new_ef, new_interval, new_reps, new_due) =
            crate::sm2::calculate_next_review(ef, interval, reps, quality);

        // Update card with new SM-2 values and timestamp
        let now = chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let n = conn
            .execute(
                "UPDATE cards
                 SET ease_factor = ?2, interval_days = ?3, repetitions = ?4, due_date = ?5, last_reviewed = ?6
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?7)",
                params![card_id, new_ef, new_interval, new_reps, new_due, now, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Card not found in this profile"));
        }
        Ok(())
    })
}

/// Update a card's subject/front/back. `profile_id` is the caller's
/// profile; the card AND the destination subject must both belong to it.
#[napi]
pub fn update_card(
    profile_id: i32,
    card_id: i32,
    subject_id: i32,
    front: String,
    back: String,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let card_id = valid_id(card_id, "card_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let front = required_text(front, "front", MAX_BLOB)?;
    let back = required_text(back, "back", MAX_BLOB)?;
    with_db(|conn| {
        assert_card_owned_by(conn, profile_id, card_id)?;
        assert_subject_owned_by(conn, profile_id, subject_id)?;
        let n = conn
            .execute(
                "UPDATE cards
                 SET subject_id = ?2, front = ?3, back = ?4
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?5)",
                params![card_id, subject_id, front, back, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Card not found in this profile"));
        }
        Ok(())
    })
}

/// Delete a card. `profile_id` is the caller's profile.
#[napi]
pub fn delete_card(profile_id: i32, card_id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let card_id = valid_id(card_id, "card_id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM cards
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?2)",
                params![card_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Card not found in this profile"));
        }
        Ok(())
    })
}

/// Helper: confirm a card exists and its subject chain belongs to
/// `profile_id`. Returns NOT_OWNED on mismatch.
fn assert_card_owned_by(conn: &Connection, profile_id: i32, card_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards c
             JOIN subjects sub ON sub.id = c.subject_id
             JOIN milestones m ON m.id = sub.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE c.id = ?1 AND t.profile_id = ?2",
            params![card_id, profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Card not found in this profile"));
    }
    Ok(())
}

/// Helper: confirm a subject exists and its chain belongs to `profile_id`.
fn assert_subject_owned_by(conn: &Connection, profile_id: i32, subject_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM subjects sub
             JOIN milestones m ON m.id = sub.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE sub.id = ?1 AND t.profile_id = ?2",
            params![subject_id, profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(
            codes::NOT_OWNED,
            "Subject does not belong to this profile",
        ));
    }
    Ok(())
}

#[napi]
pub fn get_review_stats(profile_id: i32) -> Result<ReviewStats> {
    with_db(|conn| {
        let today = today_date();

        // Due today
        let due_today: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM cards c
                 JOIN subjects s ON s.id = c.subject_id
                 JOIN milestones m ON m.id = s.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1 AND c.due_date <= ?2",
                params![profile_id, today],
                |row| row.get(0),
            )
            .map_err(to_err)?;

        // Reviewed today (cards with last_reviewed set to today)
        let reviewed_today: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM cards c
                 JOIN subjects s ON s.id = c.subject_id
                 JOIN milestones m ON m.id = s.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1 AND date(c.last_reviewed) = ?2",
                params![profile_id, today],
                |row| row.get(0),
            )
            .map_err(to_err)?;

        // Total cards
        let total_cards: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM cards c
                 JOIN subjects s ON s.id = c.subject_id
                 JOIN milestones m ON m.id = s.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1",
                params![profile_id],
                |row| row.get(0),
            )
            .map_err(to_err)?;

        // Streak: consecutive days with at least one review (ending today/yesterday)
        let mut review_days: std::collections::HashSet<String> = std::collections::HashSet::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT date(c.last_reviewed) FROM cards c
                     JOIN subjects s ON s.id = c.subject_id
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1 AND c.last_reviewed IS NOT NULL",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |row| row.get::<_, String>(0))
                .map_err(to_err)?;
            for row in rows {
                if let Ok(d) = row {
                    review_days.insert(d);
                }
            }
        }
        let date_at = |off: i32| -> Result<String> {
            conn.query_row(
                "SELECT date('now','localtime', ?1)",
                params![format!("-{off} days")],
                |r| r.get(0),
            )
            .map_err(to_err)
        };
        let mut streak = 0;
        let mut off = if review_days.contains(&date_at(0)?) {
            0
        } else if review_days.contains(&date_at(1)?) {
            1
        } else {
            -1
        };
        if off >= 0 {
            loop {
                let d = date_at(off)?;
                if review_days.contains(&d) {
                    streak += 1;
                    off += 1;
                } else {
                    break;
                }
            }
        }

        Ok(ReviewStats {
            due_today,
            reviewed_today,
            total_cards,
            streak,
        })
    })
}
