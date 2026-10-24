// Project Mode — plan (DAG) parser & mutators.
//
// The plan is the canonical artifact the agent loop reads, writes, and
// respects. It is persisted as a JSON string in `pm_agents.plan_json`
// (TEXT column). This module is the single source of truth for the
// in-memory shape; persistence is the loop's job (via
// `core.pmUpdateAgent`).
//
// Plan shape (the canonical JSON the model should produce):
//   { steps: [
//       { id: "step-1", title: "...", status: "pending|running|done|failed|skipped",
//         depends_on: ["step-2"], files: ["src/..."],
//         assigned_to: "coder|tester|reviewer|null" }
//     ],
//     version: 1
//   }
//
// OR a plain array (legacy) — accept both shapes.
//
// Pure functions only. No IO. No dependencies on the agent loop.

const TERMINAL_STATUSES = new Set(["done", "failed", "skipped"]);

function normalizeStatus(s) {
  if (typeof s !== "string") return "pending";
  const lc = s.toLowerCase();
  if (lc === "completed") return "done";
  if (TERMINAL_STATUSES.has(lc)) return lc;
  if (lc === "running") return "running";
  return "pending";
}

function normalizeStep(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
  if (!id) return null;
  const title = typeof raw.title === "string" && raw.title.length > 0
    ? raw.title
    : (typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id);
  const depends_on = Array.isArray(raw.depends_on)
    ? raw.depends_on.filter((d) => typeof d === "string")
    : [];
  const files = Array.isArray(raw.files)
    ? raw.files.filter((f) => typeof f === "string")
    : [];
  const assigned_to = typeof raw.assigned_to === "string" ? raw.assigned_to : null;
  return {
    id,
    title,
    status: normalizeStatus(raw.status),
    depends_on,
    files,
    assigned_to,
  };
}

/**
 * Parse a stored plan_json string into the canonical plan object.
 * Accepts:
 *   - a JSON string (the storage shape) → parsed
 *   - null / undefined / "" / non-string → { steps: [] }
 *   - a plain array (legacy) → wrapped as { steps: [...] }
 *   - an object with `steps` array → kept as-is
 * Never throws; bad JSON returns { steps: [] }.
 */
export function parsePlan(planJsonString) {
  if (typeof planJsonString !== "string" || planJsonString.length === 0) {
    return { steps: [], version: 1 };
  }
  let raw;
  try {
    raw = JSON.parse(planJsonString);
  } catch (_e) {
    return { steps: [], version: 1 };
  }
  if (Array.isArray(raw)) {
    return { steps: raw.map(normalizeStep).filter(Boolean), version: 1 };
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.steps)) {
    return {
      steps: raw.steps.map(normalizeStep).filter(Boolean),
      version: typeof raw.version === "number" ? raw.version : 1,
    };
  }
  return { steps: [], version: 1 };
}

/**
 * Validate a plan object. Returns { ok, error? }.
 *   - steps must be an array
 *   - every step must have a non-empty string id
 *   - ids must be unique across the plan
 *   - depends_on entries must reference an existing step id
 *   - depends_on graph must be acyclic
 *   - status must be one of the known statuses (normalized otherwise)
 */
export function validatePlan(plan) {
  if (!plan || typeof plan !== "object") {
    return { ok: false, error: "plan must be an object" };
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const seen = new Set();
  for (const s of steps) {
    if (!s || typeof s !== "object") return { ok: false, error: "step must be an object" };
    if (typeof s.id !== "string" || s.id.length === 0) {
      return { ok: false, error: "step.id must be a non-empty string" };
    }
    if (seen.has(s.id)) return { ok: false, error: `duplicate step id: ${s.id}` };
    seen.add(s.id);
  }
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
    for (const d of deps) {
      if (!ids.has(d)) {
        return { ok: false, error: `step ${s.id} depends on unknown step ${d}` };
      }
    }
  }
  // Cycle detection via DFS coloring. White=0, gray=1, black=2.
  const color = new Map();
  for (const s of steps) color.set(s.id, 0);
  const stack = [];
  function visit(id) {
    if (color.get(id) === 1) return true; // back edge -> cycle
    if (color.get(id) === 2) return false;
    color.set(id, 1);
    const step = steps.find((s) => s.id === id);
    const deps = step && Array.isArray(step.depends_on) ? step.depends_on : [];
    for (const d of deps) {
      if (visit(d)) return true;
    }
    color.set(id, 2);
    return false;
  }
  for (const s of steps) {
    if (visit(s.id)) {
      return { ok: false, error: `cycle in depends_on starting at ${s.id}` };
    }
  }
  return { ok: true };
}

/**
 * Build a single-step starter plan for an objective. The model is
 * expected to expand it on its first reply; this is just a non-empty
 * placeholder so the persisted column is meaningful.
 */
export function buildInitialPlan({ objective } = {}) {
  const title = (typeof objective === "string" && objective.length > 0)
    ? objective.slice(0, 200)
    : "Plan the work";
  return {
    steps: [
      {
        id: "step-1",
        title,
        status: "pending",
        depends_on: [],
        files: [],
        assigned_to: null,
      },
    ],
    version: 1,
  };
}

/**
 * Return the steps that are eligible to run RIGHT NOW: status is
 * 'pending' and every step in depends_on is in a terminal state
 * (done | failed | skipped). Failed/skipped deps do not block — they
 * just stop propagation.
 *
 * Returns a NEW array; the plan is not mutated.
 */
export function nextReadySteps(plan) {
  if (!plan || !Array.isArray(plan.steps)) return [];
  const byId = new Map();
  for (const s of plan.steps) byId.set(s.id, s);
  return plan.steps.filter((s) => {
    if (s.status !== "pending") return false;
    const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
    for (const d of deps) {
      const dep = byId.get(d);
      if (!dep) continue; // unknown dep is a validation error, not a runtime block
      if (!TERMINAL_STATUSES.has(dep.status)) return false;
    }
    return true;
  });
}

/**
 * Return a NEW plan object with the named step's status changed.
 * Other steps are deep-cloned (shallow clone of the top-level object is
 * sufficient for our shape: every step is a flat object of primitives).
 * The original `plan` is never mutated.
 */
export function markStep(plan, stepId, newStatus) {
  const status = normalizeStatus(newStatus);
  const steps = (plan && Array.isArray(plan.steps) ? plan.steps : []).map((s) => {
    if (s.id !== stepId) return s;
    return { ...s, status };
  });
  return {
    steps,
    version: plan && typeof plan.version === "number" ? plan.version : 1,
  };
}

/**
 * A plan is complete when every step has reached a terminal status
 * (done | failed | skipped). An empty plan is NOT complete — an empty
 * plan means the model hasn't produced one yet, not that it's done.
 */
export function isPlanComplete(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return false;
  for (const s of plan.steps) {
    if (!TERMINAL_STATUSES.has(s.status)) return false;
  }
  return true;
}

/**
 * Round-trip helper. Produces a JSON string the NAPI surface can
 * store in pm_agents.plan_json (TEXT).
 */
export function planToJson(plan) {
  if (!plan || typeof plan !== "object") return JSON.stringify({ steps: [], version: 1 });
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return JSON.stringify({
    steps: steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
      files: Array.isArray(s.files) ? s.files : [],
      assigned_to: s.assigned_to == null ? null : s.assigned_to,
    })),
    version: typeof plan.version === "number" ? plan.version : 1,
  });
}
