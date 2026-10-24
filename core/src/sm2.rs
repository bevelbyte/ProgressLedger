// SM-2 Spaced Repetition Algorithm
// Based on Piotr Wozniak's SuperMemo 2 algorithm
// https://www.supermemo.com/en/archives1990-2015/english/ol/sm2

use chrono::Duration;

/// SM-2 review quality ratings (0-5 scale)
/// 0 - Complete blackout, no memory at all
/// 1 - Wrong answer, but upon seeing correct answer, remembered it
/// 2 - Wrong answer, but subject matter seemed easy to recall
/// 3 - Correct answer with serious difficulty (after long hesitation)
/// 4 - Correct answer after some hesitation
/// 5 - Perfect response, instant recall
pub fn calculate_next_review(
    ease_factor: f64,
    interval: i32,
    repetitions: i32,
    quality: i32,
) -> (f64, i32, i32, String) {
    // Validate quality range
    let q = quality.clamp(0, 5);

    // Calculate new ease factor
    // EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
    let new_ef = if q >= 3 {
        let ef_change = 0.1 - (5.0 - q as f64) * (0.08 + (5.0 - q as f64) * 0.02);
        (ease_factor + ef_change).max(1.3) // EF cannot be less than 1.3
    } else {
        ease_factor // EF doesn't change on failed reviews
    };

    // Calculate new interval
    let new_interval = if q < 3 {
        // Failed review: reset to 1 day
        1
    } else if repetitions == 0 {
        // First successful review
        1
    } else if repetitions == 1 {
        // Second successful review
        6
    } else {
        // Subsequent reviews: I(n) = I(n-1) * EF
        (interval as f64 * new_ef).round() as i32
    };

    // Calculate new repetitions
    let new_reps = if q < 3 {
        0 // Reset on failure
    } else {
        repetitions + 1
    };

    // Calculate due date
    let due_date = chrono::Local::now()
        .naive_local()
        .date()
        .checked_add_signed(Duration::days(new_interval as i64))
        .unwrap_or_else(|| chrono::Local::now().naive_local().date())
        .format("%Y-%m-%d")
        .to_string();

    (new_ef, new_interval, new_reps, due_date)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_first_review_good() {
        let (ef, interval, reps, _due) = calculate_next_review(2.5, 0, 0, 4);
        assert!((ef - 2.5).abs() < 0.01); // EF unchanged on first review
        assert_eq!(interval, 1); // First interval is 1 day
        assert_eq!(reps, 1); // First successful repetition
    }

    #[test]
    fn test_second_review_good() {
        let (ef, interval, reps, _due) = calculate_next_review(2.5, 1, 1, 4);
        assert!((ef - 2.5).abs() < 0.01);
        assert_eq!(interval, 6); // Second interval is 6 days
        assert_eq!(reps, 2);
    }

    #[test]
    fn test_third_review_good() {
        let (ef, interval, reps, _due) = calculate_next_review(2.5, 6, 2, 4);
        assert!((ef - 2.5).abs() < 0.01);
        assert_eq!(interval, 15); // 6 * 2.5 = 15
        assert_eq!(reps, 3);
    }

    #[test]
    fn test_failed_review() {
        let (ef, interval, reps, _due) = calculate_next_review(2.5, 15, 3, 1);
        assert!((ef - 2.5).abs() < 0.01); // EF unchanged on failure
        assert_eq!(interval, 1); // Reset to 1 day
        assert_eq!(reps, 0); // Reset repetitions
    }

    #[test]
    fn test_easy_review() {
        let (ef, interval, reps, _due) = calculate_next_review(2.5, 15, 3, 5);
        assert!(ef > 2.5); // EF increases on easy review
        assert_eq!(interval, 39); // 15 * 2.6 = 39
        assert_eq!(reps, 4);
    }

    #[test]
    fn test_hard_review() {
        let (ef, interval, reps, _due) = calculate_next_review(2.5, 15, 3, 3);
        assert!(ef < 2.5); // EF decreases on hard review
        assert!(interval > 15); // Interval still increases
        assert_eq!(reps, 4);
    }
}
