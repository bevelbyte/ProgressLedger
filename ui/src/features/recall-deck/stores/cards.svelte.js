import { cardsService } from "../services/cards.service.js";
import { toast } from "../../../shared/stores/toasts.svelte.js";
import { reportError } from "../../../shared/utils/errors.js";
import { getIntervalText } from "../utils/card-helpers.js";

// Global Recall Deck state (Svelte 5 runes)
export const cardsStore = $state({
  dueCards: [],
  allCards: [],
  stats: null,
  loading: false,
  currentIndex: 0,
  showAnswer: false,
  sessionMode: false,
  viewMode: "due", // "due" | "all"
  academicTree: [],
  previousStreak: null,

  get currentCard() {
    return this.dueCards[this.currentIndex] ?? null;
  },

  get progress() {
    return this.dueCards.length > 0
      ? Math.round((this.currentIndex / this.dueCards.length) * 100)
      : 0;
  },

  get allSubjects() {
    const subjects = [];
    for (const track of this.academicTree) {
      for (const sem of track.semesters || []) {
        for (const ms of sem.milestones || []) {
          for (const subj of ms.subjects || []) {
            subjects.push({ id: subj.id, name: subj.name, track: track.name });
          }
        }
      }
    }
    return subjects;
  }
});

/**
 * Load academic tree
 */
export async function loadAcademicTree(profileId) {
  if (profileId == null) {
    cardsStore.academicTree = [];
    return;
  }
  try {
    cardsStore.academicTree = await cardsService.getAcademicTree(profileId);
  } catch (e) {
    console.error("loadAcademicTree failed:", e);
    cardsStore.academicTree = [];
  }
}

/**
 * Load all cards, due cards, stats, and academic tree
 */
export async function loadData(profileId) {
  if (profileId == null) {
    cardsStore.dueCards = [];
    cardsStore.allCards = [];
    cardsStore.stats = null;
    return;
  }
  cardsStore.loading = true;
  try {
    await loadAcademicTree(profileId);
    cardsStore.dueCards = await cardsService.due(profileId);
    cardsStore.allCards = await cardsService.all(profileId);
    cardsStore.stats = await cardsService.stats(profileId);
    cardsStore.currentIndex = 0;
    cardsStore.showAnswer = false;
  } catch (e) {
    reportError(e);
  } finally {
    cardsStore.loading = false;
  }
}

/**
 * Start a review session
 */
export function startSession() {
  if (cardsStore.dueCards.length === 0) return;
  cardsStore.sessionMode = true;
  cardsStore.previousStreak = cardsStore.stats?.streak ?? 0;
  cardsStore.currentIndex = 0;
  cardsStore.showAnswer = false;
}

/**
 * End a review session
 */
export function endSession(profileId) {
  cardsStore.sessionMode = false;
  loadData(profileId);
}

/**
 * Check for streak milestones and show toast
 */
export function checkStreakMilestone(oldStreak, newStreak) {
  const milestones = [3, 7, 14, 30, 60, 100, 200, 365];
  for (const milestone of milestones) {
    if (oldStreak < milestone && newStreak >= milestone) {
      const messages = {
        3: "Three days strong! Keep it up!",
  // Copy only — the toast host supplies the icon. Emoji in a *title string*
  // rendered next to a real icon glyph twice over, in the system font.
  7: "One week streak! You're building a habit.",
  14: "Two weeks! Outstanding consistency.",
  30: "One month streak! You're unstoppable.",
  60: "Two months! Incredible dedication.",
  100: "100 days! Legendary status.",
  200: "200 days! Academic mastery.",
  365: "A full year! You are a scholar.",
      };
      toast.success(messages[milestone] || `${newStreak} day streak!`, "Streak milestone");
      break;
    }
  }
}

/**
 * Submit rating/quality score for current card
 */
export async function rateCard(profileId, quality) {
  const currentCard = cardsStore.currentCard;
  if (!currentCard) return;

  try {
    await cardsService.review(profileId, currentCard.id, quality);
    toast.success("Card reviewed!", `Next review: ${getIntervalText(quality)}`);

    if (cardsStore.currentIndex < cardsStore.dueCards.length - 1) {
      cardsStore.currentIndex++;
      cardsStore.showAnswer = false;
    } else {
      // Session complete - reload stats to check for streak milestone
      const oldStreak = cardsStore.previousStreak ?? 0;
      await loadData(profileId);
      const newStreak = cardsStore.stats?.streak ?? 0;

      toast.success("Session complete", `All ${cardsStore.dueCards.length} card${cardsStore.dueCards.length > 1 ? 's' : ''} reviewed!`);

      // Check for streak milestone after session
      checkStreakMilestone(oldStreak, newStreak);

      endSession(profileId);

      // Reviews changed due-state and the study streak. Notify other features
      // (Dashboard/Today, Subject Workspace) once the session ends — emitting
      // per-card would re-enter this deck's own cf:data-changed listener and
      // reset the in-progress session, so we signal only at completion.
      window.dispatchEvent(new Event("cf:data-changed"));
    }
  } catch (e) {
    reportError(e);
  }
}
