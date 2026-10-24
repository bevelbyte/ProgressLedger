/**
 * Card Helpers - Pure formatting and state representation utilities
 */

export function formatDate(dateStr) {
  if (!dateStr) return "Never";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function getCardStatus(card) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(card.dueDate + "T00:00:00");
  const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return { text: "Overdue", class: "overdue" };
  if (diffDays === 0) return { text: "Due today", class: "due-today" };
  if (diffDays <= 3) return { text: `${diffDays}d`, class: "soon" };
  return { text: `${diffDays}d`, class: "later" };
}

export function getDifficultyLevel(card) {
  if (card.easeFactor >= 2.5) return { text: "Easy", class: "easy" };
  if (card.easeFactor >= 2.0) return { text: "Normal", class: "normal" };
  if (card.easeFactor >= 1.5) return { text: "Hard", class: "hard" };
  return { text: "Very Hard", class: "very-hard" };
}

export function getIntervalText(quality) {
  // Approximate interval text based on quality
  if (quality <= 1) return "1 day";
  if (quality === 2) return "1 day";
  if (quality === 3) return "~3 days";
  if (quality === 4) return "~1 week";
  return "~2 weeks";
}
