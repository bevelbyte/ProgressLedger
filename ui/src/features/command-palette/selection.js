/**
 * Keyboard selection movement for the palette's result list. Pure, so the
 * wrap-around and empty-list behaviour are unit-testable without mounting the
 * overlay.
 */

/**
 * Move the highlighted result by `delta` positions, wrapping at both ends.
 *
 * Out-of-range or non-finite positions are treated as 0 rather than propagating
 * a stale index — the result list can shrink to zero while a query is being
 * edited, and a negative offset into an empty list would otherwise produce a
 * nonsense index that no row could match.
 *
 * @param {number} count   number of results
 * @param {number} current currently highlighted index
 * @param {number} delta   +1 to move down, -1 to move up
 * @returns {number} the next highlighted index
 */
export function moveSelection(count, current, delta) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const from = Number.isFinite(current) && current >= 0 && current < count ? current : 0;
  return (from + delta + count) % count;
}
