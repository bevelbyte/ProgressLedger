/**
 * Focus Feature - Public API Contract
 *
 * Subject-scoped focus sessions: a focused surface that runs a timer against a
 * real subject and logs the result as one existing Study Session. Study Sessions
 * remains the source of truth; Focus has no persistence of its own.
 */

export { default as FocusSession } from "./components/FocusSession.svelte";
export { focusService } from "./services/focus.service.js";
