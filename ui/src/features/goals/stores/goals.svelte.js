// Goals store (Svelte 5 runes).
//
// Holds goals + active selection + events + per-goal linked-agent
// snapshot for progress. Linked-agent snapshots are fetched on demand
// from the IPC projectMode.getAgent channel. The renderer never invents
// progress — every field in `progress[goalId]` is computed from the
// persisted pm_agents row + its plan_json.

import { goalsService } from "../services/goals.service.js";
import { goalProgress, phaseLabel, PHASES } from "../lib/progress.js";

const state = $state({
  goals: [],
  activeGoalId: null,
  loading: false,
  error: null,
  lastEvent: null,
  events: [],
  // Map<goalId, agentRow> — cached linked-agent rows so the UI can
  // render truthful progress without hitting IPC on every render.
  agentSnapshots: {},
  // Map<goalId, promise> — to dedupe concurrent fetches.
  agentInflight: {},
});

let _unsubscribeEngine = null;

function norm(row) {
  if (!row || typeof row !== "object") return row;
  return {
    id: row.id,
    profileId: row.profileId ?? row.profile_id,
    projectId: row.projectId ?? row.project_id,
    title: row.title,
    objective: row.objective,
    kind: row.kind,
    state: row.state,
    priority: row.priority,
    requireVerification: row.requireVerification ?? row.require_verification,
    linkedAgentId: row.linkedAgentId ?? row.linked_agent_id ?? null,
    failureReason: row.failureReason ?? row.failure_reason ?? "",
    resultText: row.resultText ?? row.result_text ?? "",
    planStepCount: row.planStepCount ?? row.plan_step_count ?? 0,
    createdAt: row.createdAt ?? row.created_at,
    startedAt: row.startedAt ?? row.started_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at,
    completedAt: row.completedAt ?? row.completed_at ?? null,
  };
}

export const goalsStore = {
  get goals() { return state.goals; },
  get activeGoalId() { return state.activeGoalId; },
  get activeGoal() {
    return state.goals.find((g) => g.id === state.activeGoalId) || null;
  },
  get loading() { return state.loading; },
  get error() { return state.error; },
  get lastEvent() { return state.lastEvent; },
  get events() { return state.events; },

  /**
   * Read the linked agent snapshot for a goal. Returns null if the
   * goal has no linked agent, or null if the snapshot has not been
   * loaded yet (caller should call refreshAgentSnapshot first).
   */
  agentSnapshotFor(goalId) {
    if (goalId == null) return null;
    return state.agentSnapshots[goalId] || null;
  },

  /**
   * Compute truthful progress for a goal. Falls back to phase=preparing
   * when the linked-agent snapshot is not yet loaded.
   */
  progressFor(goal) {
    if (!goal) return goalProgress(null, null);
    const agent = goal.linkedAgentId ? state.agentSnapshots[goal.id] || null : null;
    return goalProgress(goal, agent);
  },

  phaseLabel,
  PHASES,

  subscribeEngine() {
    if (_unsubscribeEngine) {
      try { _unsubscribeEngine(); } catch (_e) {}
      _unsubscribeEngine = null;
    }
    const svc = window.careerflow && window.careerflow.goals;
    if (!svc || typeof svc.onEvent !== "function") return;
    _unsubscribeEngine = svc.onEvent((evt) => {
      state.lastEvent = { ...evt, receivedAt: Date.now() };
      const activeId = state.activeGoalId;
      if (activeId != null && evt && evt.goalId === activeId) {
        const svc2 = window.careerflow && window.careerflow.goals;
        if (svc2 && typeof svc2.get === "function") {
          const profileId = state.goals.find((g) => g.id === activeId)?.profileId;
          if (profileId != null) {
            svc2.get(profileId, activeId).then((row) => {
              if (!row || row.ok === false) return;
              const normalised = norm(row);
              state.goals = state.goals.map((g) => (g.id === activeId ? normalised : g));
              // Refresh agent snapshot too.
              if (normalised.linkedAgentId) refreshAgentSnapshot(normalised);
            }).catch(() => {});
          }
        }
      }
      const profileId = state.goals[0]?.profileId;
      if (profileId != null) {
        svc.list(profileId, { limit: 100 }).then((rows) => {
          if (Array.isArray(rows)) state.goals = rows.map(norm);
        }).catch(() => {});
      }
    });
  },

  reset() {
    state.goals = [];
    state.activeGoalId = null;
    state.error = null;
    state.lastEvent = null;
    state.events = [];
    state.agentSnapshots = {};
    state.agentInflight = {};
    if (_unsubscribeEngine) {
      try { _unsubscribeEngine(); } catch (_e) {}
      _unsubscribeEngine = null;
    }
  },

  async loadGoals(profileId) {
    if (typeof profileId !== "number") return;
    state.loading = true;
    state.error = null;
    try {
      const rows = await goalsService.list(profileId, { limit: 100 });
      if (!Array.isArray(rows)) {
        state.error = "Failed to load goals";
        return;
      }
      state.goals = rows.map(norm);
      // Eagerly refresh linked-agent snapshots so progress renders
      // immediately. Non-active goals refresh in the background.
      for (const g of state.goals) {
        if (g.linkedAgentId) refreshAgentSnapshot(g).catch(() => {});
      }
    } catch (e) {
      state.error = String(e && e.message || e);
    } finally {
      state.loading = false;
    }
  },

  async refreshAgentSnapshot(goal) {
    if (!goal || goal.linkedAgentId == null) return;
    const id = goal.id;
    // Dedup concurrent fetches per goal.
    if (state.agentInflight[id]) return state.agentInflight[id];
    const promise = (async () => {
      try {
        const pm = window.careerflow && window.careerflow.projectMode;
        if (!pm || typeof pm.getAgent !== "function") return;
        const profileId = goal.profileId;
        if (typeof profileId !== "number") return;
        const row = await pm.getAgent(profileId, goal.linkedAgentId);
        if (row && row.ok !== false) {
          // getAgent returns raw NAPI row; alias to camelCase in the
          // snapshot so progress.js can read planJson uniformly.
          state.agentSnapshots[id] = {
            id: row.id,
            state: row.state,
            planJson: typeof row.planJson === "string" ? row.planJson : (row.plan_json || "[]"),
            tokensIn: Number(row.tokensIn || row.tokens_in || 0),
            tokensOut: Number(row.tokensOut || row.tokens_out || 0),
            finishedAt: row.finishedAt || row.finished_at || null,
          };
        }
      } catch (_e) {
        // swallow — UI will keep showing cached/empty snapshot
      } finally {
        delete state.agentInflight[id];
      }
    })();
    state.agentInflight[id] = promise;
    return promise;
  },

  async createGoal(profileId, payload) {
    if (typeof profileId !== "number") return { ok: false, error: "invalid-profile-id" };
    const res = await goalsService.create({ profileId, ...payload });
    if (res && typeof res === "object" && res.ok === false) {
      state.error = (res && res.error) || "Goal-create failed";
      return res;
    }
    await this.loadGoals(profileId);
    return { ok: true, id: typeof res === "number" ? res : (res && res.id) };
  },

  selectGoal(goalId) {
    state.activeGoalId = goalId;
    state.events = [];
    if (goalId == null) return;
    const goal = state.goals.find((g) => g.id === goalId);
    if (!goal) return;
    goalsService.listEvents(goal.profileId, goalId, 100).then((rows) => {
      if (Array.isArray(rows)) {
        state.events = rows.map((r) => ({
          id: r.id,
          goalId: r.goalId ?? r.goal_id,
          event: r.event,
          message: r.message,
          payloadJson: r.payloadJson ?? r.payload_json ?? null,
          createdAt: r.createdAt ?? r.created_at,
        }));
      }
    }).catch(() => {});
    if (goal.linkedAgentId) refreshAgentSnapshot(goal).catch(() => {});
  },

  async startGoal(profileId, goalId) {
    const res = await goalsService.start(profileId, goalId);
    await this.loadGoals(profileId);
    return res;
  },

  async cancelGoal(profileId, goalId) {
    const res = await goalsService.cancel(profileId, goalId);
    await this.loadGoals(profileId);
    return res;
  },

  async removeGoal(profileId, goalId) {
    const res = await goalsService.remove(profileId, goalId);
    if (res && res.ok !== false) {
      state.goals = state.goals.filter((g) => g.id !== goalId);
      if (state.activeGoalId === goalId) state.activeGoalId = null;
      delete state.agentSnapshots[goalId];
    }
    return res;
  },

  async reconcile(profileId) {
    const res = await goalsService.reconcile(profileId);
    await this.loadGoals(profileId);
    return res;
  },

  byState(stateName) {
    return state.goals.filter((g) => g.state === stateName);
  },

  isTerminal(stateName) {
    return stateName === "completed" || stateName === "failed" || stateName === "cancelled";
  },

  // Phase 15 — test-only seed helper. The store exposes getters only
  // (the runes proxy is non-writable), so tests use this entry point
  // to inject fixtures. Production code never calls this.
  __testSeed(goals, events = []) {
    state.goals = goals.slice();
    state.activeGoalId = null;
    state.error = null;
    state.events = events.slice();
    state.agentSnapshots = {};
    state.agentInflight = {};
  },

  // Phase 16 — test-only agent-snapshot seeder. Lets tests inject the
  // linked pm_agents snapshot (state + plan_json) that progressFor()
  // derives from, without going through the IPC layer.
  __testSeedAgentSnapshot(agentId, snapshot) {
    if (agentId == null) return;
    state.agentSnapshots[agentId] = snapshot;
  },

  // Delegate to the module-level subscribeEngineEvents function.
  subscribeEngine() {
    return subscribeEngineEvents();
  },
};

export { norm };

// Free-function re-exports so components can call them as plain
// functions (the existing GoalsPanel/GoalDetailView import style).
// Each is a thin wrapper that delegates to the store.
export function loadGoals(profileId) {
  return goalsStore.loadGoals(profileId);
}
export function createGoal(profileId, payload) {
  return goalsStore.createGoal(profileId, payload);
}
export function selectGoal(goalId) {
  return goalsStore.selectGoal(goalId);
}
export function startGoal(profileId, goalId) {
  return goalsStore.startGoal(profileId, goalId);
}
export function cancelGoal(profileId, goalId) {
  return goalsStore.cancelGoal(profileId, goalId);
}
export function removeGoal(profileId, goalId) {
  return goalsStore.removeGoal(profileId, goalId);
}
export function reconcileGoals(profileId) {
  return goalsStore.reconcile(profileId);
}

// Internal helper exposed for unit tests.
export function refreshAgentSnapshot(goal) {
  return goalsStore.refreshAgentSnapshot(goal);
}

// Module-level singleton subscription. The store method
// `goalsStore.subscribeEngine` calls into this; the public
// `subscribeEngineEvents` export below is a thin alias for components
// that import it directly.
let _moduleUnsubscribe = null;
export function subscribeEngineEvents() {
  if (_moduleUnsubscribe) {
    try { _moduleUnsubscribe(); } catch (_e) {}
    _moduleUnsubscribe = null;
  }
  const svc = window.careerflow && window.careerflow.goals;
  if (!svc || typeof svc.onEvent !== "function") return;
  _moduleUnsubscribe = svc.onEvent((evt) => {
    state.lastEvent = { ...evt, receivedAt: Date.now() };
    const activeId = state.activeGoalId;
    if (activeId != null && evt && evt.goalId === activeId) {
      const svc2 = window.careerflow && window.careerflow.goals;
      if (svc2 && typeof svc2.get === "function") {
        const profileId = state.goals.find((g) => g.id === activeId)?.profileId;
        if (profileId != null) {
          svc2.get(profileId, activeId).then((row) => {
            if (!row || row.ok === false) return;
            const normalised = norm(row);
            state.goals = state.goals.map((g) => (g.id === activeId ? normalised : g));
            if (normalised.linkedAgentId) goalsStore.refreshAgentSnapshot(normalised);
          }).catch(() => {});
        }
      }
    }
    const profileId = state.goals[0]?.profileId;
    if (profileId != null) {
      svc.list(profileId, { limit: 100 }).then((rows) => {
        if (Array.isArray(rows)) state.goals = rows.map(norm);
      }).catch(() => {});
    }
  });
}