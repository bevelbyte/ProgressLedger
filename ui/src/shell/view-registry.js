// Atlas shell — view registry.
//
// The single declaration of every destination in the app: its rail label,
// its activity plane, and the context-header copy it presents.
//
// IMPORTANT — `label` values are functional contracts. The E2E suite drives
// navigation with `button.nav-item:has-text("<label>")`, and the Runs console
// is matched with an anchored `/^\s*Project\s*$/`, so labels must not be
// renamed or pluralised. See docs/DESIGN-ATLAS.md §9.

import {
  Home,
  GraduationCap,
  Library,
  FlaskConical,
  FolderKanban,
  Layers,
  AlertTriangle,
  Sigma,
  Globe,
  CalendarClock,
  Timer,
  UserRound,
  SquareTerminal,
  Target,
  Compass,
  Settings2,
} from "lucide-svelte";

/**
 * Activity planes, in rail order. `footer: true` pins a plane to the bottom
 * of the rail — workspace-level concerns, separated from work-level ones.
 */
export const PLANES = [
  { id: "today", label: "Today" },
  { id: "spaces", label: "Spaces" },
  { id: "plan", label: "Plan" },
  { id: "library", label: "Library" },
  { id: "operator", label: "Operator" },
  { id: "system", label: "System", footer: true },
];

export const VIEWS = [
  {
    id: "home",
    label: "Home",
    plane: "today",
    icon: Home,
    title: "Desk",
    subtitle: "What is due, what is next, and where to start.",
  },
  {
    id: "tree",
    label: "Subjects",
    plane: "spaces",
    icon: Library,
    title: "Subjects",
    subtitle: "Every subject you are carrying, and everything attached to it.",
  },
  {
    id: "projects",
    label: "Projects",
    plane: "spaces",
    icon: FolderKanban,
    title: "Projects",
    subtitle: "Things you are building, with their tasks and deadlines.",
  },
  {
    id: "cgpa",
    label: "Degree",
    plane: "spaces",
    icon: GraduationCap,
    title: "Degree",
    subtitle: "Semesters, grades, SGPA and CGPA across your programme.",
  },
  {
    id: "labs",
    label: "Labs",
    plane: "spaces",
    icon: FlaskConical,
    title: "Labs",
    subtitle: "Experiment records and viva progress per subject.",
  },
  {
    id: "deadlines",
    label: "Deadlines",
    plane: "plan",
    icon: CalendarClock,
    title: "Deadlines",
    subtitle: "Everything with a date, ordered by how close it is.",
  },
  {
    id: "sessions",
    label: "Study Sessions",
    plane: "plan",
    icon: Timer,
    title: "Study Sessions",
    subtitle: "Time you have actually logged, by subject and by day.",
  },
  {
    id: "goals",
    label: "Goals",
    plane: "plan",
    icon: Target,
    title: "Goals",
    subtitle: "Outcomes you are driving, and the runs working toward them.",
  },
  {
    id: "career",
    label: "Career",
    plane: "plan",
    icon: Compass,
    title: "Career Plan",
    subtitle: "Where you are heading, and the milestones that get you there.",
  },
  {
    id: "flashcards",
    label: "Flashcards",
    plane: "library",
    icon: Layers,
    title: "Flashcards",
    subtitle: "Spaced repetition across every subject you study.",
  },
  {
    id: "mistakes",
    label: "Mistakes",
    plane: "library",
    icon: AlertTriangle,
    title: "Mistake Ledger",
    subtitle: "Errors you have logged, grouped by type and subject.",
  },
  {
    id: "formulas",
    label: "Formulas",
    plane: "library",
    icon: Sigma,
    title: "Formula Board",
    subtitle: "Your LaTeX reference, searchable by subject and category.",
  },
  {
    id: "project",
    label: "Project",
    plane: "operator",
    icon: SquareTerminal,
    title: "Runs",
    subtitle: "Every agent run, its plan, its changes and its approvals.",
  },
  {
    id: "browser",
    label: "Browser",
    plane: "operator",
    icon: Globe,
    title: "Research",
    subtitle: "Saved places, the live browser, and what the operator did there.",
  },
  {
    // THE EMBEDDED BROWSER'S PAGE SURFACE (D2-D6 plan, Phase 1).
    //
    // `hidden: true` because a web page is not a rail destination: it is opened
    // from a pane (or a link) and lives as a workspace TAB, exactly like the
    // Lab's `/page/<id>` surface. Hidden views are excluded from `railGroups()`
    // and `orderedViews()`, so the rail, its labels (E2E contracts) and the
    // Ctrl+1..9 positional order are untouched. It stays in VIEWS so the
    // derived context taxonomy still owns it exactly once (ledger G12).
    id: "page",
    label: "Page",
    plane: "operator",
    icon: Globe,
    hidden: true,
    title: "Web page",
    subtitle: "A live page in the CareerFlow-owned browser.",
  },
  {
    id: "research-ledger",
    label: "Research ledger",
    plane: "operator",
    icon: Compass,
    // Reachable as a normal Operator destination, but don't open an empty ledger
    // tab at startup; browser source-return actions open it when useful.
    seed: false,
    title: "Research ledger",
    subtitle: "Saved browser sources, kept passages, and operator extractions.",
  },
  {
    id: "profiles",
    label: "Profiles",
    plane: "system",
    icon: UserRound,
    title: "Profiles",
    subtitle: "Separate workspaces. Everything you see is scoped to one.",
  },
  {
    id: "settings",
    label: "Settings",
    plane: "system",
    icon: Settings2,
    title: "Settings",
    subtitle: "Workspace, data, sync, grading, diagnostics and updates.",
  },
];

const BY_ID = new Map(VIEWS.map((v) => [v.id, v]));

/**
 * Short captions for the numeric (slim) rail.
 *
 * WHY THIS IS A SEPARATE MAP. `label` above is a functional contract and must
 * stay spelled out in full: the E2E suite matches several of them with an
 * ANCHORED regex (`/^\s*Subjects\s*$/`, `/^\s*Degree\s*$/`), so the button's
 * text content has to be exactly that word and nothing else. The slim rail is
 * 64px wide, which leaves ~48px for the caption; at the instrument caption
 * size that is roughly eight characters, and every label in this list is
 * longer -- "SUBJECTS", "DEADLINES", "FLASHCARDS", "STUDY SESSIONS". Showing
 * the full word there means a permanent ellipsis on most of the rail, which
 * reads as broken rather than dense.
 *
 * So the full label STAYS in the DOM (and in `textContent`, and as the
 * button's accessible name) and is hidden from sight with the standard
 * screen-reader-only technique, while the caption is rendered by CSS from
 * `attr(data-caption)`. Pseudo-element content never enters `textContent`, so
 * this is invisible to Playwright's `:has-text()` / `hasText` matching and to
 * the accessible name.
 *
 * Captions are kept to five characters so nothing wraps at any rail width.
 */
const CAPTIONS = {
  home: "HOME",
  tree: "SUBJ",
  projects: "PROJ",
  cgpa: "DEG",
  labs: "LABS",
  deadlines: "DEAD",
  sessions: "SESS",
  goals: "GOALS",
  career: "PLAN",
  flashcards: "CARD",
  mistakes: "MIST",
  formulas: "FORM",
  project: "RUNS",
  browser: "WEB",
  "research-ledger": "RSCH",
  profiles: "PROFS",
  settings: "CONF",
};

/**
 * Short caption for the slim rail, with the full label as the fallback so a
 * newly added view degrades to a (clipped) full label rather than to nothing.
 */
export function captionFor(id) {
  const v = BY_ID.get(id);
  return CAPTIONS[id] ?? v?.label ?? "";
}

/** Look up a view descriptor. Returns undefined for an unknown view id. */
export function viewFor(id) {
  return BY_ID.get(id);
}

/**
 * The rail's destinations: the registry MINUS hidden surfaces.
 *
 * `hidden` exists because a destination and a *surface* are not the same thing.
 * A web page (`page`) is a real view the shell must render, but offering "Page"
 * in the rail would be meaningless — you do not navigate to "a page", you open
 * one. Hidden views keep their registry identity (and their owning context), so
 * nothing about the taxonomy forks; they simply do not appear as destinations.
 */
export function railViews() {
  return VIEWS.filter((v) => v.hidden !== true);
}

/** The rail, grouped by plane and in rail order. */
export function railGroups() {
  return PLANES.map((plane) => ({
    ...plane,
    items: railViews().filter((v) => v.plane === plane.id),
  })).filter((g) => g.items.length > 0);
}

/** Views in rail order — used for the Ctrl+1..9 positional jumps. */
export function orderedViews() {
  return railGroups().flatMap((g) => g.items);
}

/**
 * Destinations that are meaningless without a selected profile.
 *
 * This lives HERE, not in NavRail, because it is a routing rule and not a
 * rendering rule: the rail merely *reflects* it by disabling the item, while
 * every entry point that can change the current view (rail click, `cf:navigate`,
 * deep link, and the Ctrl+1..9 positional jump) has to HONOUR it. When the set
 * lived only in NavRail, `Ctrl+8` routed straight to a destination the rail was
 * showing as disabled, and that view then waited on a profile that would never
 * arrive.
 */
const PROFILE_GATED = new Set(["browser", "project", "goals", "career"]);

/** True when `id` must stay unreachable until a profile is selected. */
export function isProfileGated(id, profileReady) {
  return PROFILE_GATED.has(id) && !profileReady;
}
