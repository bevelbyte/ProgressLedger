/**
 * Default contexts — Progress Ledger's own working domains.
 *
 * The Lab seeded contexts from its simulated research world (Desk / Research /
 * Algorithms / Thesis / Operator). Main has no such world, so the seeds here
 * are DERIVED from the destinations Main actually has: every view's context is
 * decided by the `plane` view-registry.js already declares, through the one
 * PLANE_TO_CONTEXT mapping below. That mapping is the single source of truth
 * tying the two taxonomies together — a view added to the registry lands in
 * the right domain without anyone editing a second list.
 *
 * RECONCILIATION (ledger G12, 2026-10-06). The first W1 transfer hand-grouped
 * the views and drifted: Goals and Career (registry plane `plan`) sat in the
 * Operator context, and Projects (plane `spaces`) was owned by NO context at
 * all, so navigating to it dropped it into whatever context was active. The
 * derivation fixes both by construction: the whole `plan` plane belongs to
 * Study (your degree AND your planning), and Operator is exactly the machine
 * plane (Runs, Browser).
 *
 * WHY `System` IS ACTIVE AT BOOT. The shell has always opened on the Profiles
 * destination when no profile is selected, and 20 E2E specs depend on that
 * (`e2e/smoke.spec.js` fills the "New profile name" field on the first screen).
 * W1 must not change what the app does on launch, so the active context at boot
 * is the one that owns `profiles`, with `profiles` active inside it.
 */

import { createContext, uid } from "./model.js";
import { VIEWS } from "../view-registry.js";

/**
 * Registry plane → working domain (context seed name). Written out in full —
 * not derived — because it IS the decision; everything else follows from it.
 */
export const PLANE_TO_CONTEXT = {
  today: "Desk",
  spaces: "Study",
  plan: "Study",
  library: "Library",
  operator: "Operator",
  system: "System",
};

/**
 * The non-view part of each context: display identity and boot state. Order
 * here is the context strip's order. Views come from the registry via
 * PLANE_TO_CONTEXT — see CONTEXT_SEEDS below.
 *
 * @type {Array<{name:string, icon:string, hue:string, activeView?:string}>}
 */
const CONTEXT_SHELLS = [
  { name: "Desk", icon: "home", hue: "you" },
  { name: "Study", icon: "graduation-cap", hue: "you" },
  { name: "Library", icon: "layers", hue: "info" },
  { name: "Operator", icon: "square-terminal", hue: "machine" },
  { name: "System", icon: "settings-2", hue: "info", activeView: "profiles" },
];

/**
 * The boot contexts: each shell plus the views its plane(s) own, in rail
 * order, with the registry's labels (which are the E2E contract strings).
 *
 * @type {Array<{name:string, icon:string, hue:string, views:{view:string,label:string}[], activeView?:string}>}
 */
export const CONTEXT_SEEDS = CONTEXT_SHELLS.map((shell) => ({
  ...shell,
  // Seeds are the destinations a context opens with, subject to the registry's
  // explicit `seed: false` opt-out. A hidden surface such as `page` is not a
  // rail destination and is also unseeded by default; Research ledger remains a
  // real rail destination but opts out of a blank startup tab.
  views: VIEWS.filter(
    (v) => v.seed !== false && v.hidden !== true && PLANE_TO_CONTEXT[v.plane] === shell.name,
  ).map((v) => ({
    view: v.id,
    label: v.label,
  })),
}));

/**
 * Which seeded domain owns each view — the first context that lists it.
 *
 * Used by `store.navigate`: a destination belongs to a working domain, so
 * navigating to `deadlines` from anywhere lands in Study rather than dumping
 * Deadlines into whatever context happened to be active. Keyed by view, valued
 * by the context's `seed` (NOT its name — a renamed context keeps its domain).
 */
export const CONTEXT_OWNER = (() => {
  /** @type {Record<string, string>} */
  const map = {};
  // Derived from the REGISTRY, not from CONTEXT_SEEDS: ownership must cover every
  // view the shell can render, including a `hidden` surface such as `page` that
  // is deliberately not seeded as a bare tab. Deriving from the filtered seeds
  // would leave a hidden view unowned, which is the exact class of drift the G12
  // reconciliation removed (a destination that belongs nowhere lands wherever
  // the user happens to be standing).
  for (const v of VIEWS) map[v.id] = PLANE_TO_CONTEXT[v.plane];
  return map;
})();

/** The boot workspace. Ids are minted here so a reload rebuilds a clean one. */
export function defaultWorkspace() {
  const contexts = CONTEXT_SEEDS.map((seed) =>
    createContext({
      id: uid("ctx"),
      name: seed.name,
      seed: seed.name,
      icon: seed.icon,
      hue: seed.hue,
      views: seed.views,
      activeView: seed.activeView,
    }),
  );
  const system = contexts[contexts.length - 1];
  return {
    contexts,
    activeContextId: system.id,
    lastClosed: null,
    immerse: false,
  };
}
