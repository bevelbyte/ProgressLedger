/**
 * Command Palette Service - IPC API wrapper for full-text search resources
 */

export const commandPaletteService = {
  async search(profileId, query) {
    return await window.progressLedger.resources.search(profileId, query);
  }
};
