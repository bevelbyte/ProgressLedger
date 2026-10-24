import { describe, it, expect, vi } from "vitest";
import { splitTrackName, composeTrackName, buildDegreesFromDb, persistDegreesToDb } from "../src/features/cgpa/degree-mapper.js";

describe("degree-mapper track name helpers", () => {
  it("splits specialization out of the track name", () => {
    expect(splitTrackName("B.Tech (CSE)")).toEqual({ name: "B.Tech", specialization: "CSE" });
    expect(splitTrackName("B.Sc Computer Science")).toEqual({
      name: "B.Sc Computer Science",
      specialization: "",
    });
  });

  it("composes and round-trips", () => {
    expect(composeTrackName("B.Tech", "CSE")).toBe("B.Tech (CSE)");
    expect(composeTrackName("B.Sc", "")).toBe("B.Sc");
    const { name, specialization } = splitTrackName(composeTrackName("M.Tech", "AI"));
    expect([name, specialization]).toEqual(["M.Tech", "AI"]);
  });
});

describe("buildDegreesFromDb", () => {
  it("merges academic tree structure with course marks/credits", async () => {
    const api = {
      academic: {
        tree: vi.fn().mockResolvedValue([
          {
            id: 1,
            name: "B.Tech (CSE)",
            semesters: [
              {
                id: 10,
                name: "Semester 1",
                status: "Completed",
                milestones: [
                  { id: 100, title: "Subjects", subjects: [{ id: 1000, name: "Maths", code: "M1", status: "done" }] },
                ],
              },
            ],
          },
        ]),
      },
      courses: {
        list: vi.fn().mockResolvedValue([
          { id: 5, semesterLabel: "Semester 1", courseName: "Maths", credits: 4, marksObtained: 85, maxMarks: 100 },
        ]),
      },
    };

    const degrees = await buildDegreesFromDb(api, 1);
    expect(degrees).toHaveLength(1);
    expect(degrees[0].name).toBe("B.Tech");
    expect(degrees[0].specialization).toBe("CSE");
    const subj = degrees[0].semesters[0].patterns["Semester Exam"].subjects[0];
    expect(subj).toMatchObject({
      name: "Maths",
      code: "M1",
      credits: 4,
      marksObtained: 85,
      maxMarks: 100,
      courseId: 5,
      subjectId: 1000,
    });
    // Semester status is read from the persisted semester row, not derived.
    expect(degrees[0].semesters[0].status).toBe("Completed");
  });
});

describe("persistDegreesToDb", () => {
  it("creates track, semester, milestone, subject, and course for a new degree", async () => {
    const calls = [];
    const api = {
      academic: {
        tree: vi.fn().mockResolvedValue([]),
        addTrack: vi.fn((...a) => { calls.push(["addTrack", ...a]); return Promise.resolve(1); }),
        addSemester: vi.fn((...a) => { calls.push(["addSemester", ...a]); return Promise.resolve(10); }),
        addMilestone: vi.fn((...a) => { calls.push(["addMilestone", ...a]); return Promise.resolve(100); }),
        addSubject: vi.fn((...a) => { calls.push(["addSubject", ...a]); return Promise.resolve(1000); }),
        updateSubject: vi.fn(),
        setSemesterStatus: vi.fn((...a) => { calls.push(["setSemesterStatus", ...a]); return Promise.resolve(); }),
        deleteSubject: vi.fn(),
        deleteSemester: vi.fn(),
        deleteTrack: vi.fn(),
      },
      courses: {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn((...a) => { calls.push(["courseAdd", ...a]); return Promise.resolve(7); }),
        update: vi.fn(),
        remove: vi.fn(),
      },
    };

    const degrees = [
      {
        name: "B.Tech",
        specialization: "CSE",
        semestersCount: 1,
        semesters: [
          {
            number: 1,
            status: "In Progress",
            patterns: {
              "Internal - I": { subjects: [] },
              "Internal - II": { subjects: [] },
              "Semester Exam": {
                subjects: [{ name: "Maths", code: "M1", credits: 4, marksObtained: 85, maxMarks: 100 }],
              },
            },
          },
        ],
      },
    ];

    await persistDegreesToDb(api, 1, degrees);

    expect(api.academic.addTrack).toHaveBeenCalledWith(1, "B.Tech (CSE)");
    expect(api.academic.addSemester).toHaveBeenCalledWith(1, 1, "Semester 1");
    // User-declared semester status is persisted onto the semester row.
    expect(api.academic.setSemesterStatus).toHaveBeenCalledWith(1, 10, "In Progress");
    expect(api.academic.addMilestone).toHaveBeenCalledWith(1, 10, "Subjects");
    expect(api.academic.addSubject).toHaveBeenCalledWith(1, 100, "Maths", "M1");
    expect(api.courses.add).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 1,
        semesterLabel: "Semester 1",
        courseName: "Maths",
        credits: 4,
        marksObtained: 85,
        maxMarks: 100,
      })
    );
  });
});
