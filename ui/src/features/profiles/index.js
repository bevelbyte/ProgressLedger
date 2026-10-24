/**
 * Profiles Feature - Public API
 */

export { default as ProfileManager } from './components/ProfileManager.svelte';
export { profileService } from './services/profile.service.js';
export { 
  profileStore, 
  loadProfiles, 
  addProfile, 
  selectProfile,
  deleteProfile, 
  exportProfile, 
  importProfile 
} from './stores/profile.svelte.js';
