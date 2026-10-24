// PlanTemplates — UI tests.
//
// Coverage:
//   - renders one row per saved template with name/desc/step count
//   - "Save current plan as template" posts the active plan to the IPC
//   - "Load template" calls pmLoadPlanTemplate and emits the plan via
//     the onLoadTemplate callback
//   - empty state when the IPC returns []
//   - "Save" button is disabled when the name field is empty

import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import PlanTemplates from "../src/features/project-mode/components/PlanTemplates.svelte";
import { projectModeStore } from "../src/features/project-mode/stores/projectMode.svelte.js";

const TEMPLATE_A = {
  id: 1,
  profile_id: 7,
  name: "Triage & Investigation",
  description: "Standard triage flow",
  plan_json: JSON.stringify({ steps: [{ id: "s1", title: "triage" }], version: 1 }),
  step_count: 1,
  created_at: "2026-08-30T10:00:00.000Z",
  updated_at: "2026-08-30T10:00:00.000Z",
};
const TEMPLATE_B = {
  id: 2,
  profile_id: 7,
  name: "Refactor pass",
  description: "",
  plan_json: JSON.stringify({ steps: [], version: 1 }),
  step_count: 0,
  created_at: "2026-08-30T11:00:00.000Z",
  updated_at: "2026-08-30T11:00:00.000Z",
};

function setupIpc({ templates = [], deleteOk = true } = {}) {
  const listPlanTemplates = vi.fn().mockResolvedValue(templates);
  const savePlanTemplate = vi.fn().mockResolvedValue({ id: 99, ok: true });
  const loadPlanTemplate = vi.fn().mockImplementation((_p, id) =>
    Promise.resolve(templates.find((t) => t.id === id) || null)
  );
  const deletePlanTemplate = vi.fn().mockResolvedValue(deleteOk ? { ok: true } : { ok: false, reason: "not-found" });
  window.progressLedger = {
    projectMode: {
      listPlanTemplates,
      savePlanTemplate,
      loadPlanTemplate,
      deletePlanTemplate,
    },
  };
  return { listPlanTemplates, savePlanTemplate, loadPlanTemplate, deletePlanTemplate };
}

beforeEach(() => {
  window.progressLedger = undefined;
  // Reset the renderer plan store so each test starts clean.
  projectModeStore.plan = [];
});

afterEach(() => {
  cleanup();
});

describe("PlanTemplates", () => {
  it("lists templates returned by the IPC", async () => {
    const { listPlanTemplates } = setupIpc({ templates: [TEMPLATE_A, TEMPLATE_B] });
    render(PlanTemplates, { props: { profileId: 7 } });

    await waitFor(() => {
      expect(listPlanTemplates).toHaveBeenCalledWith(7);
    });

    const table = await screen.findByTestId("plan-templates-table");
    expect(table).toBeInTheDocument();
    expect(screen.getByTestId("plan-templates-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("plan-templates-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("plan-templates-name-1")).toHaveTextContent("Triage & Investigation");
    expect(screen.getByTestId("plan-templates-desc-1")).toHaveTextContent("Standard triage flow");
    expect(screen.getByTestId("plan-templates-count-1")).toHaveTextContent("1");
  });

  it("renders the empty state when there are no templates", async () => {
    setupIpc({ templates: [] });
    render(PlanTemplates, { props: { profileId: 7 } });
    const empty = await screen.findByTestId("plan-templates-empty");
    expect(empty).toBeInTheDocument();
    expect(screen.queryByTestId("plan-templates-table")).not.toBeInTheDocument();
  });

  it("saves the active plan as a template", async () => {
    const { savePlanTemplate, listPlanTemplates } = setupIpc({ templates: [] });
    // Seed the active plan in the store.
    projectModeStore.plan = [
      { id: "step-1", title: "Investigate", status: "pending", depends_on: [], files: [], assigned_to: null },
      { id: "step-2", title: "Patch", status: "pending", depends_on: ["step-1"], files: [], assigned_to: null },
    ];

    render(PlanTemplates, { props: { profileId: 7 } });

    // Open the save form.
    fireEvent.click(screen.getByTestId("plan-templates-toggle-save"));
    const nameInput = await screen.findByTestId("plan-templates-name");
    fireEvent.input(nameInput, { target: { value: "My Triage Plan" } });
    const descInput = screen.getByTestId("plan-templates-description");
    fireEvent.input(descInput, { target: { value: "Custom triage" } });

    fireEvent.click(screen.getByTestId("plan-templates-save"));

    await waitFor(() => {
      expect(savePlanTemplate).toHaveBeenCalledTimes(1);
    });
    const [profileId, name, description, planJson] = savePlanTemplate.mock.calls[0];
    expect(profileId).toBe(7);
    expect(name).toBe("My Triage Plan");
    expect(description).toBe("Custom triage");
    const parsed = JSON.parse(planJson);
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.steps.length).toBe(2);
    expect(parsed.steps[0].id).toBe("step-1");
    // After save, listPlanTemplates is re-invoked to refresh the table.
    expect(listPlanTemplates.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("disables the save button when the name is empty", async () => {
    setupIpc({ templates: [] });
    render(PlanTemplates, { props: { profileId: 7 } });
    fireEvent.click(screen.getByTestId("plan-templates-toggle-save"));
    const saveBtn = await screen.findByTestId("plan-templates-save");
    expect(saveBtn).toBeDisabled();

    const nameInput = screen.getByTestId("plan-templates-name");
    fireEvent.input(nameInput, { target: { value: "  " } });
    expect(saveBtn).toBeDisabled();

    fireEvent.input(nameInput, { target: { value: "ok" } });
    expect(saveBtn).not.toBeDisabled();
  });

  it("loads a template via the IPC and forwards the plan via onLoadTemplate", async () => {
    const { loadPlanTemplate } = setupIpc({ templates: [TEMPLATE_A] });
    const onLoadTemplate = vi.fn();
    render(PlanTemplates, { props: { profileId: 7, onLoadTemplate } });

    const loadBtn = await screen.findByTestId("plan-templates-load-1");
    fireEvent.click(loadBtn);

    await waitFor(() => {
      expect(loadPlanTemplate).toHaveBeenCalledWith(7, 1, null);
    });
    await waitFor(() => {
      expect(onLoadTemplate).toHaveBeenCalledTimes(1);
    });
    const arg = onLoadTemplate.mock.calls[0][0];
    expect(arg.id).toBe(1);
    expect(arg.name).toBe("Triage & Investigation");
    expect(typeof arg.planJson).toBe("string");
    expect(JSON.parse(arg.planJson).steps[0].id).toBe("s1");
  });

  it("shows a Delete button per row", async () => {
    setupIpc({ templates: [TEMPLATE_A] });
    render(PlanTemplates, { props: { profileId: 7 } });
    const deleteBtn = await screen.findByTestId("plan-templates-delete-1");
    expect(deleteBtn).toBeInTheDocument();
    expect(deleteBtn).toHaveTextContent("Delete");
  });

  it("replaces Load/Delete with Yes/No confirmation when Delete is clicked", async () => {
    setupIpc({ templates: [TEMPLATE_A] });
    render(PlanTemplates, { props: { profileId: 7 } });

    const deleteBtn = await screen.findByTestId("plan-templates-delete-1");
    fireEvent.click(deleteBtn);

    const confirmYes = await screen.findByTestId("plan-templates-delete-confirm-1");
    const confirmNo = await screen.findByTestId("plan-templates-delete-cancel-1");
    expect(confirmYes).toBeInTheDocument();
    expect(confirmNo).toBeInTheDocument();
    // The original delete button should be gone.
    expect(screen.queryByTestId("plan-templates-delete-1")).not.toBeInTheDocument();
  });

  it("cancelling delete restores the original buttons", async () => {
    setupIpc({ templates: [TEMPLATE_A] });
    render(PlanTemplates, { props: { profileId: 7 } });

    const deleteBtn = await screen.findByTestId("plan-templates-delete-1");
    fireEvent.click(deleteBtn);

    const confirmNo = await screen.findByTestId("plan-templates-delete-cancel-1");
    fireEvent.click(confirmNo);

    expect(screen.queryByTestId("plan-templates-delete-confirm-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-templates-delete-1")).toBeInTheDocument();
  });

  it("confirming delete calls the IPC and removes the row", async () => {
    const { deletePlanTemplate, listPlanTemplates } = setupIpc({ templates: [TEMPLATE_A, TEMPLATE_B] });
    // After delete, the list refresh returns only the remaining template.
    // Use mockImplementation so the first call (initial load) returns the full
    // list and subsequent calls (post-delete refresh) return the filtered list.
    let deleted = false;
    listPlanTemplates.mockImplementation(() =>
      Promise.resolve(deleted ? [TEMPLATE_B] : [TEMPLATE_A, TEMPLATE_B])
    );
    render(PlanTemplates, { props: { profileId: 7 } });

    const deleteBtn = await screen.findByTestId("plan-templates-delete-1");
    fireEvent.click(deleteBtn);

    const confirmYes = await screen.findByTestId("plan-templates-delete-confirm-1");
    // Mark as deleted BEFORE confirming so the post-delete list refresh
    // returns the filtered list (the component calls load() after delete).
    deleted = true;
    fireEvent.click(confirmYes);

    await waitFor(() => {
      expect(deletePlanTemplate).toHaveBeenCalledWith(7, 1);
    });
    // After delete, listPlanTemplates is re-invoked to refresh the table.
    await waitFor(() => {
      expect(listPlanTemplates.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    // Row 1 should be gone; row 2 should remain.
    await waitFor(() => {
      expect(screen.queryByTestId("plan-templates-row-1")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("plan-templates-row-2")).toBeInTheDocument();
  });

  it("deleting a non-existent template returns ok:false gracefully", async () => {
    const { deletePlanTemplate } = setupIpc({ templates: [TEMPLATE_A], deleteOk: false });
    render(PlanTemplates, { props: { profileId: 7 } });

    const deleteBtn = await screen.findByTestId("plan-templates-delete-1");
    fireEvent.click(deleteBtn);

    const confirmYes = await screen.findByTestId("plan-templates-delete-confirm-1");
    fireEvent.click(confirmYes);

    await waitFor(() => {
      expect(deletePlanTemplate).toHaveBeenCalledWith(7, 1);
    });
    // The confirmation dialog should be dismissed (no crash, no infinite spinner).
    await waitFor(() => {
      expect(screen.queryByTestId("plan-templates-delete-confirm-1")).not.toBeInTheDocument();
    });
    // The error message should be shown.
    const errorEl = await screen.findByTestId("plan-templates-error");
    expect(errorEl).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// D13 — NATIVE (camelCase) rows.
//
// `plan:list-templates` / `plan:load-template` return RAW napi rows
// (`planJson`, `stepCount`, `createdAt`); the fixtures above are the LEGACY
// shape. A snake-only read made "Load" hit `!result.plan_json` and return early
// for every REAL template - i.e. loading silently did nothing.
// ---------------------------------------------------------------------------

describe("PlanTemplates — native (camelCase) rows", () => {
  const NATIVE_TEMPLATE = {
    id: 11,
    profileId: 7,
    name: "Native shape",
    description: "native",
    planJson: JSON.stringify({ steps: [{ id: "s1", title: "triage" }], version: 1 }),
    stepCount: 1,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  };

  it("renders step count/date and actually LOADS the plan from the camelCase fields", async () => {
    const onLoadTemplate = vi.fn();
    setupIpc({ templates: [NATIVE_TEMPLATE] });
    render(PlanTemplates, { props: { profileId: 7, onLoadTemplate } });

    expect(await screen.findByTestId("plan-templates-count-11")).toHaveTextContent("1");
    expect(screen.getByTestId("plan-templates-date-11")).toHaveTextContent("2026-08-30");

    await fireEvent.click(screen.getByTestId("plan-templates-load-11"));
    await waitFor(() => expect(onLoadTemplate).toHaveBeenCalledTimes(1));
    const payload = onLoadTemplate.mock.calls[0][0];
    expect(payload).toMatchObject({ id: 11, name: "Native shape" });
    expect(String(payload.planJson)).toContain("triage");
  });
});