// Notes persistence boundary — regression coverage for a real, silent
// data-integrity defect.
//
// WHAT WAS BROKEN
//   `noteService` has 4-argument signatures:
//       get(profileId, resourceId)
//       updateNote(profileId, resourceId, title, content)
//       addNote(profileId, subjectId, title, content)
//   and the preload/handler chain is positionally identical:
//       resources.addNote(profileId, subjectId, title, content)
//         -> "resources:add-note" { profileId, subjectId, title, content }
//         -> core.addNote(profileId, subjectId, title, content)
//
//   Both call sites dropped the profile id:
//       QuickNote : noteService.addNote(subjectId, title, content)   (3 args)
//       NoteEditor: noteService.updateNote(resourceId, title, content)(3 args)
//                  noteService.addNote(subjectId, title, content)   (3 args)
//                  noteService.get(profileId, resourceId)             (undeclared!)
//
//   Because the boundary is positional, the call SUCCEEDED at the IPC layer
//   and every argument shifted one slot left. A note was filed with
//   profileId = the subject id, subjectId = the note title (a string),
//   title = the note body, and content = undefined. Nothing rejected it:
//   `shell/src/ipc/resources.js` performs no type or ownership validation.
//
//   NoteEditor had no `profileId` prop at all, so its LOAD threw
//   `ReferenceError: profileId is not defined`, was swallowed by
//   `.catch(e => console.error(e))`, and the editor silently opened BLANK — so
//   the next Save overwrote the note with an empty title and body.
//
// WHAT THIS LOCKS IN
//   The profile id is the FIRST argument on every note call, the editor
//   receives it as a prop, and neither surface will write without one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import NoteEditor from "../src/features/notes/components/NoteEditor.svelte";
import QuickNote from "../src/features/notes/components/QuickNote.svelte";
import { noteService } from "../src/features/notes/services/note.service.js";
import { toastState, clearToasts } from "../src/shared/stores/toasts.svelte.js";

// `<Toaster />` is mounted once in App.svelte and is not part of these
// components, so the toast STORE is the honest place to assert that a refusal
// was actually reported to the user.
const toastText = () => toastState.items.map((t) => `${t.title} ${t.message}`).join(" | ");

// `screen` from @testing-library/svelte v5 does not carry the DOM-only
// placeholder query in this setup, so the two editors are addressed through
// their own container roots.
const titleInput = (c) => c.querySelector('input[placeholder="Note title"]');
const bodyInput = (c) => c.querySelector("textarea");
const quickTitleInput = (c) => c.querySelector(".quick-note-modal input.title-input");
const quickBodyInput = (c) => c.querySelector(".quick-note-modal textarea.content-input");
const saveButton = (c) => [...c.querySelectorAll("button")].find((b) => /save/i.test(b.textContent || ""));

const PROFILE_ID = 42;
const SUBJECT_ID = 7;

function installIpcMock() {
  const calls = { get: [], addNote: [], updateNote: [] };
  window.careerflow = {
    resources: {
      get: vi.fn((payload) => {
        calls.get.push(payload);
        return Promise.resolve({
          id: payload?.id,
          kind: "note",
          title: "Existing title",
          content: "Existing body",
        });
      }),
      addNote: vi.fn((profileId, subjectId, title, content) => {
        calls.addNote.push({ profileId, subjectId, title, content });
        return Promise.resolve({ ok: true, id: 101 });
      }),
      updateNote: vi.fn((profileId, id, title, content) => {
        calls.updateNote.push({ profileId, id, title, content });
        return Promise.resolve({ ok: true });
      }),
    },
  };
  return calls;
}

const ACADEMIC_TREE = [
  {
    id: 1,
    name: "Computer Science BSc",
    semesters: [
      {
        id: 11,
        number: 1,
        name: "Semester 1",
        milestones: [
          { id: 111, title: "Core", subjects: [{ id: SUBJECT_ID, name: "Computer Networks" }] },
        ],
      },
    ],
  },
];

beforeEach(() => {
  window.careerflow = undefined;
  clearToasts();
});

afterEach(() => {
  cleanup();
  window.careerflow = undefined;
  clearToasts();
  vi.restoreAllMocks();
});

describe("noteService — positional contract with the resources IPC", () => {
  it("passes profileId first on addNote", async () => {
    const calls = installIpcMock();
    await noteService.addNote(PROFILE_ID, SUBJECT_ID, "Title", "Body");
    expect(calls.addNote).toEqual([
      { profileId: PROFILE_ID, subjectId: SUBJECT_ID, title: "Title", content: "Body" },
    ]);
  });

  it("passes profileId first on updateNote", async () => {
    const calls = installIpcMock();
    await noteService.updateNote(PROFILE_ID, 55, "Title", "Body");
    expect(calls.updateNote).toEqual([
      { profileId: PROFILE_ID, id: 55, title: "Title", content: "Body" },
    ]);
  });

  it("passes profileId on get", async () => {
    const calls = installIpcMock();
    await noteService.get(PROFILE_ID, 55);
    expect(calls.get).toEqual([{ profileId: PROFILE_ID, id: 55 }]);
  });
});

describe("QuickNote — writes a subject-scoped note into the ACTIVE profile", () => {
  it("sends (profileId, subjectId, title, content) in that order", async () => {
    const calls = installIpcMock();
    const { container } = render(QuickNote, {
      props: { open: true, profileId: PROFILE_ID, academicTree: ACADEMIC_TREE, onClose: () => {} },
    });

    await fireEvent.input(quickTitleInput(container), { target: { value: "My title" } });
    await fireEvent.input(quickBodyInput(container), { target: { value: "My body" } });
    await fireEvent.click(saveButton(container));

    await waitFor(() => expect(calls.addNote.length).toBe(1));
    expect(calls.addNote[0]).toEqual({
      profileId: PROFILE_ID,
      subjectId: SUBJECT_ID,
      title: "My title",
      content: "My body",
    });
  });

  it("refuses to write when there is no active profile", async () => {
    const calls = installIpcMock();
    const { container } = render(QuickNote, {
      props: { open: true, profileId: null, academicTree: ACADEMIC_TREE, onClose: () => {} },
    });

    await fireEvent.input(quickTitleInput(container), { target: { value: "My title" } });
    await fireEvent.click(saveButton(container));

    await waitFor(() => expect(toastText()).toMatch(/select a profile first/i));
    // The critical assertion: nothing reached the IPC boundary at all.
    expect(calls.addNote).toHaveLength(0);
  });
});

describe("NoteEditor — opens an existing note in the active profile", () => {
  it("loads the existing note instead of silently opening blank", async () => {
    const calls = installIpcMock();
    const { container } = render(NoteEditor, {
      props: { open: true, profileId: PROFILE_ID, resourceId: 55, subjectId: SUBJECT_ID, onClose: () => {} },
    });

    await waitFor(() => expect(calls.get.length).toBe(1));
    expect(calls.get[0]).toEqual({ profileId: PROFILE_ID, id: 55 });

    // The loaded title/body must actually reach the inputs. The old code threw
    // `ReferenceError: profileId is not defined` here, the error was swallowed,
    // and both fields stayed empty.
    await waitFor(() => expect(titleInput(container).value).toBe("Existing title"));
    expect(bodyInput(container).value).toBe("Existing body");
  });

  it("updates an existing note with (profileId, resourceId, title, content)", async () => {
    const calls = installIpcMock();
    const { container } = render(NoteEditor, {
      props: { open: true, profileId: PROFILE_ID, resourceId: 55, subjectId: SUBJECT_ID, onClose: () => {} },
    });
    await waitFor(() => expect(titleInput(container).value).toBe("Existing title"));

    await fireEvent.input(titleInput(container), { target: { value: "Renamed" } });
    await fireEvent.click(saveButton(container));

    await waitFor(() => expect(calls.updateNote.length).toBe(1));
    expect(calls.updateNote[0]).toEqual({
      profileId: PROFILE_ID,
      id: 55,
      title: "Renamed",
      content: "Existing body",
    });
  });

  it("creates a note with (profileId, subjectId, title, content)", async () => {
    const calls = installIpcMock();
    const { container } = render(NoteEditor, {
      props: { open: true, profileId: PROFILE_ID, resourceId: null, subjectId: SUBJECT_ID, onClose: () => {} },
    });

    await fireEvent.input(titleInput(container), { target: { value: "Fresh" } });
    await fireEvent.input(bodyInput(container), { target: { value: "Body" } });
    await fireEvent.click(saveButton(container));

    await waitFor(() => expect(calls.addNote.length).toBe(1));
    expect(calls.addNote[0]).toEqual({
      profileId: PROFILE_ID,
      subjectId: SUBJECT_ID,
      title: "Fresh",
      content: "Body",
    });
  });

  it("refuses to write when there is no active profile rather than misfiling", async () => {
    const calls = installIpcMock();
    const { container } = render(NoteEditor, {
      props: { open: true, profileId: null, resourceId: null, subjectId: SUBJECT_ID, onClose: () => {} },
    });

    await fireEvent.input(titleInput(container), { target: { value: "Fresh" } });
    await fireEvent.click(saveButton(container));

    await waitFor(() => expect(toastText()).toMatch(/select a profile first/i));
    expect(calls.addNote).toHaveLength(0);
  });

  it("refuses to write when there is no subject to attach the note to", async () => {
    const calls = installIpcMock();
    const { container } = render(NoteEditor, {
      props: { open: true, profileId: PROFILE_ID, resourceId: null, subjectId: null, onClose: () => {} },
    });

    await fireEvent.input(titleInput(container), { target: { value: "Fresh" } });
    await fireEvent.click(saveButton(container));

    await waitFor(() => expect(toastText()).toMatch(/no subject/i));
    expect(calls.addNote).toHaveLength(0);
  });
});
