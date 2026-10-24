//! Pure CGPA/SGPA domain logic — no SQLite, no N-API, no I/O.
//!
//! CareerFlow's authoritative academic-performance model. The pipeline is:
//!
//! ```text
//! obtained marks + max marks  ->  percentage  ->  grade point (via GradeScale)
//!   ->  credit x grade point  ->  SGPA (per semester)  ->  CGPA (all semesters)
//! ```
//!
//! Grade points are credit-weighted. The percentage->grade-point mapping is NOT
//! hardcoded: it is supplied by a `GradeScale`, so different institutions can
//! define different bands and even a different maximum grade point (a 4.0 system
//! works as well as a 10.0 one). This module only defines the math; persistence
//! and the concrete per-profile scale live in the db layer.

/// One band of a grading scale: percentages `>= min_percent` (and below the next
/// higher band's threshold) earn `grade_point`. `label` is display-only (e.g. "A+").
#[derive(Clone, Debug, PartialEq)]
pub struct GradeBand {
    pub min_percent: f64,
    pub grade_point: f64,
    pub label: String,
}

/// An ordered set of bands. Not assumed to be 10-point or to have any fixed
/// number of bands. A percentage maps to the highest band whose `min_percent`
/// it satisfies; below the lowest band it earns 0.0 (a fail).
#[derive(Clone, Debug)]
pub struct GradeScale {
    pub bands: Vec<GradeBand>,
}

impl GradeScale {
    /// Grade point for a percentage. Bands are considered highest-threshold
    /// first, so ordering in the input vec does not matter.
    pub fn grade_point(&self, percent: f64) -> f64 {
        let mut best: Option<&GradeBand> = None;
        for band in &self.bands {
            if percent + f64::EPSILON >= band.min_percent {
                match best {
                    Some(b) if b.min_percent >= band.min_percent => {}
                    _ => best = Some(band),
                }
            }
        }
        best.map(|b| b.grade_point).unwrap_or(0.0)
    }

    /// Display label for a percentage, if any band matches. Part of the domain
    /// API (used by tests and available to callers that render grade letters);
    /// not yet consumed by the persistence layer.
    #[allow(dead_code)]
    pub fn label(&self, percent: f64) -> Option<String> {
        let mut best: Option<&GradeBand> = None;
        for band in &self.bands {
            if percent + f64::EPSILON >= band.min_percent {
                match best {
                    Some(b) if b.min_percent >= band.min_percent => {}
                    _ => best = Some(band),
                }
            }
        }
        best.map(|b| b.label.clone())
    }

    /// Validate a grade scale for consistency. Returns `Ok(())` or a
    /// human-readable reason. These are the authoritative rules the UI must
    /// enforce (it should call `validate_grade_scale` rather than re-inventing
    /// them): at least one band, percentages within 0..=100, grade points
    /// non-negative, no two bands sharing a `min_percent` (which would make the
    /// mapping ambiguous), and a band starting at 0 so every percentage maps to
    /// some grade point (no impossible gap at the bottom).
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.bands.is_empty() {
            return Err("A grade scale needs at least one band.".into());
        }
        let mut seen_min: Vec<f64> = Vec::new();
        let mut has_zero_floor = false;
        for b in &self.bands {
            if !(0.0..=100.0).contains(&b.min_percent) {
                return Err(format!(
                    "Band minimum percent {} must be between 0 and 100.",
                    b.min_percent
                ));
            }
            if b.grade_point < 0.0 {
                return Err(format!("Grade point {} cannot be negative.", b.grade_point));
            }
            if seen_min
                .iter()
                .any(|m| (m - b.min_percent).abs() < f64::EPSILON)
            {
                return Err(format!(
                    "Two bands share the same minimum percent ({}); thresholds must be distinct.",
                    b.min_percent
                ));
            }
            seen_min.push(b.min_percent);
            if b.min_percent.abs() < f64::EPSILON {
                has_zero_floor = true;
            }
        }
        if !has_zero_floor {
            return Err(
                "A band starting at 0% is required so every mark maps to a grade point.".into(),
            );
        }
        Ok(())
    }
}

/// Percentage from raw marks. `None` when marks are missing or `max <= 0`
/// (an ungraded / not-yet-taken course must not contribute to SGPA/CGPA).
pub fn percentage(obtained: Option<f64>, max: Option<f64>) -> Option<f64> {
    match (obtained, max) {
        (Some(o), Some(m)) if m > 0.0 => Some((o / m) * 100.0),
        _ => None,
    }
}

/// A course as the calculator sees it. Either marks (obtained+max) drive the
/// grade point via the scale, or an explicit `grade_point_override` is used
/// (e.g. a transfer credit recorded directly as a grade). Courses that resolve
/// to no grade point are treated as ungraded and excluded from the weighting.
#[derive(Clone, Debug)]
pub struct CourseInput {
    pub credits: f64,
    pub obtained: Option<f64>,
    pub max: Option<f64>,
    pub grade_point_override: Option<f64>,
}

impl CourseInput {
    /// Resolve this course's grade point, or `None` if it is ungraded.
    fn resolved_grade_point(&self, scale: &GradeScale) -> Option<f64> {
        if let Some(gp) = self.grade_point_override {
            return Some(gp);
        }
        percentage(self.obtained, self.max).map(|p| scale.grade_point(p))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GpaResult {
    /// Credit-weighted grade-point average. 0.0 when no graded credits exist.
    pub gpa: f64,
    /// Sum of credits over *graded* courses only (ungraded courses excluded).
    pub graded_credits: f64,
    /// Sum of credit x grade_point over graded courses.
    pub weighted_points: f64,
    /// Count of graded courses that contributed.
    pub graded_count: u32,
}

/// SGPA / CGPA share the same math: credit-weighted mean of grade points over
/// all graded courses in scope. Courses with zero/negative credits are ignored
/// (they cannot carry weight); ungraded courses are ignored.
pub fn weighted_gpa(courses: &[CourseInput], scale: &GradeScale) -> GpaResult {
    let mut graded_credits = 0.0;
    let mut weighted_points = 0.0;
    let mut graded_count = 0u32;

    for c in courses {
        if c.credits <= 0.0 {
            continue;
        }
        if let Some(gp) = c.resolved_grade_point(scale) {
            graded_credits += c.credits;
            weighted_points += c.credits * gp;
            graded_count += 1;
        }
    }

    let gpa = if graded_credits > 0.0 {
        weighted_points / graded_credits
    } else {
        0.0
    };

    GpaResult {
        gpa,
        graded_credits,
        weighted_points,
        graded_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ten_point_scale() -> GradeScale {
        GradeScale {
            bands: vec![
                GradeBand {
                    min_percent: 90.0,
                    grade_point: 10.0,
                    label: "O".into(),
                },
                GradeBand {
                    min_percent: 80.0,
                    grade_point: 9.0,
                    label: "A+".into(),
                },
                GradeBand {
                    min_percent: 70.0,
                    grade_point: 8.0,
                    label: "A".into(),
                },
                GradeBand {
                    min_percent: 60.0,
                    grade_point: 7.0,
                    label: "B+".into(),
                },
                GradeBand {
                    min_percent: 50.0,
                    grade_point: 6.0,
                    label: "B".into(),
                },
                GradeBand {
                    min_percent: 40.0,
                    grade_point: 5.0,
                    label: "C".into(),
                },
                GradeBand {
                    min_percent: 0.0,
                    grade_point: 0.0,
                    label: "F".into(),
                },
            ],
        }
    }

    fn course(credits: f64, obtained: Option<f64>, max: Option<f64>) -> CourseInput {
        CourseInput {
            credits,
            obtained,
            max,
            grade_point_override: None,
        }
    }

    #[test]
    fn percentage_handles_missing_and_zero_max() {
        assert_eq!(percentage(Some(75.0), Some(100.0)), Some(75.0));
        assert_eq!(percentage(None, Some(100.0)), None);
        assert_eq!(percentage(Some(50.0), None), None);
        assert_eq!(percentage(Some(50.0), Some(0.0)), None);
    }

    #[test]
    fn grade_point_maps_bands_and_boundaries() {
        let s = ten_point_scale();
        assert_eq!(s.grade_point(95.0), 10.0);
        assert_eq!(s.grade_point(90.0), 10.0); // lower boundary inclusive
        assert_eq!(s.grade_point(89.9), 9.0);
        assert_eq!(s.grade_point(40.0), 5.0);
        assert_eq!(s.grade_point(39.9), 0.0); // below lowest passing band
        assert_eq!(s.grade_point(0.0), 0.0);
    }

    #[test]
    fn band_order_in_vec_does_not_matter() {
        let reversed = GradeScale {
            bands: ten_point_scale().bands.into_iter().rev().collect(),
        };
        assert_eq!(reversed.grade_point(85.0), 9.0);
    }

    #[test]
    fn single_course_sgpa_is_its_grade_point() {
        let s = ten_point_scale();
        let r = weighted_gpa(&[course(4.0, Some(85.0), Some(100.0))], &s);
        assert_eq!(r.gpa, 9.0);
        assert_eq!(r.graded_credits, 4.0);
        assert_eq!(r.graded_count, 1);
    }

    #[test]
    fn credit_weighting_favours_higher_credit_courses() {
        let s = ten_point_scale();
        // 4cr @ 95% (10.0) + 1cr @ 40% (5.0) = (40 + 5) / 5 = 9.0
        let r = weighted_gpa(
            &[
                course(4.0, Some(95.0), Some(100.0)),
                course(1.0, Some(40.0), Some(100.0)),
            ],
            &s,
        );
        assert_eq!(r.gpa, 9.0);
        assert_eq!(r.graded_credits, 5.0);
    }

    #[test]
    fn ungraded_and_zero_credit_courses_are_excluded() {
        let s = ten_point_scale();
        let r = weighted_gpa(
            &[
                course(4.0, Some(80.0), Some(100.0)), // 9.0, counts
                course(3.0, None, Some(100.0)),       // ungraded, excluded
                course(0.0, Some(90.0), Some(100.0)), // zero credit, excluded
            ],
            &s,
        );
        assert_eq!(r.graded_count, 1);
        assert_eq!(r.graded_credits, 4.0);
        assert_eq!(r.gpa, 9.0);
    }

    #[test]
    fn empty_and_all_ungraded_yield_zero() {
        let s = ten_point_scale();
        assert_eq!(weighted_gpa(&[], &s).gpa, 0.0);
        let r = weighted_gpa(&[course(4.0, None, None)], &s);
        assert_eq!(r.gpa, 0.0);
        assert_eq!(r.graded_credits, 0.0);
        assert_eq!(r.graded_count, 0);
    }

    #[test]
    fn grade_point_override_bypasses_marks() {
        let s = ten_point_scale();
        let c = CourseInput {
            credits: 3.0,
            obtained: None,
            max: None,
            grade_point_override: Some(8.5),
        };
        let r = weighted_gpa(&[c], &s);
        assert_eq!(r.gpa, 8.5);
    }

    #[test]
    fn recalculation_after_edit_changes_result() {
        let s = ten_point_scale();
        let before = weighted_gpa(&[course(4.0, Some(55.0), Some(100.0))], &s); // 6.0
        assert_eq!(before.gpa, 6.0);
        let after = weighted_gpa(&[course(4.0, Some(75.0), Some(100.0))], &s); // 8.0
        assert_eq!(after.gpa, 8.0);
    }

    #[test]
    fn four_point_scale_is_supported() {
        // Proves the engine is not tied to a 10-point maximum.
        let four = GradeScale {
            bands: vec![
                GradeBand {
                    min_percent: 90.0,
                    grade_point: 4.0,
                    label: "A".into(),
                },
                GradeBand {
                    min_percent: 80.0,
                    grade_point: 3.0,
                    label: "B".into(),
                },
                GradeBand {
                    min_percent: 70.0,
                    grade_point: 2.0,
                    label: "C".into(),
                },
                GradeBand {
                    min_percent: 0.0,
                    grade_point: 0.0,
                    label: "F".into(),
                },
            ],
        };
        let r = weighted_gpa(&[course(3.0, Some(95.0), Some(100.0))], &four);
        assert_eq!(r.gpa, 4.0);
    }

    #[test]
    fn validate_accepts_a_well_formed_scale() {
        assert!(ten_point_scale().validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_scale() {
        let s = GradeScale { bands: vec![] };
        assert!(s.validate().is_err());
    }

    #[test]
    fn validate_rejects_duplicate_thresholds() {
        let s = GradeScale {
            bands: vec![
                GradeBand {
                    min_percent: 50.0,
                    grade_point: 6.0,
                    label: "B".into(),
                },
                GradeBand {
                    min_percent: 50.0,
                    grade_point: 5.0,
                    label: "C".into(),
                },
                GradeBand {
                    min_percent: 0.0,
                    grade_point: 0.0,
                    label: "F".into(),
                },
            ],
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn validate_rejects_out_of_range_percent() {
        let s = GradeScale {
            bands: vec![
                GradeBand {
                    min_percent: 120.0,
                    grade_point: 10.0,
                    label: "O".into(),
                },
                GradeBand {
                    min_percent: 0.0,
                    grade_point: 0.0,
                    label: "F".into(),
                },
            ],
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn validate_rejects_negative_grade_point() {
        let s = GradeScale {
            bands: vec![
                GradeBand {
                    min_percent: 50.0,
                    grade_point: -1.0,
                    label: "X".into(),
                },
                GradeBand {
                    min_percent: 0.0,
                    grade_point: 0.0,
                    label: "F".into(),
                },
            ],
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn validate_requires_a_zero_floor_band() {
        let s = GradeScale {
            bands: vec![GradeBand {
                min_percent: 40.0,
                grade_point: 5.0,
                label: "C".into(),
            }],
        };
        assert!(s.validate().is_err());
    }
}
