import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("cards:create", (_e, { profileId, subjectId, front, back }) =>
    core.createCard(profileId, subjectId, front, back)
  );
  safeHandle("cards:due", (_e, profileId) => core.getDueCards(profileId));
  safeHandle("cards:all", (_e, profileId) => core.getAllCards(profileId));
  safeHandle("cards:review", (_e, { profileId, cardId, quality }) =>
    core.reviewCard(profileId, cardId, quality)
  );
  safeHandle("cards:update", (_e, { profileId, cardId, subjectId, front, back }) =>
    core.updateCard(profileId, cardId, subjectId, front, back)
  );
  safeHandle("cards:delete", (_e, { profileId, cardId }) => core.deleteCard(profileId, cardId));
  safeHandle("cards:stats", (_e, profileId) => core.getReviewStats(profileId));
}
