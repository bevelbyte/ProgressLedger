/**
 * Shared Components - Public API
 *
 * Modal is the single dialog primitive (docs/DESIGN-ATLAS.md §14). Surfaces must
 * not hand-roll overlays: focus restore, Escape handling and the footer action
 * order are product behaviour, not per-surface styling decisions.
 *
 * Menu is the row-overflow primitive. A dense row shows one primary verb and
 * keeps the rest in a real `role="menu"`; that is how actions stay reachable
 * without eight buttons in a row.
 *
 * FaceStrip is the Space navigation primitive (docs/DESIGN-ATLAS.md §5.2).
 * Every workspace — Subject or Project — presents its angles as faces of one
 * object rather than as separate destinations on the rail, so the two Space
 * kinds are navigated identically.
 */

export { default as Toaster } from './Toaster.svelte';
export { default as Modal } from './Modal.svelte';
export { default as Menu } from './Menu.svelte';
export { default as FaceStrip } from './FaceStrip.svelte';
