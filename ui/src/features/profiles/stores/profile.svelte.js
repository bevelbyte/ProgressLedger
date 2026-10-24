import { profileService } from "../services/profile.service.js";
import { toast } from "../../../shared/stores/toasts.svelte.js";
import { reportError } from "../../../shared/utils/errors.js";

// Global profile state (Svelte 5 runes)
export const profileStore = $state({
  profiles: [],
  activeProfileId: null,
  porting: false,

  get activeProfile() {
    return this.profiles.find((p) => p.id === this.activeProfileId) ?? null;
  }
});

// The active profile survives reloads: it is persisted to localStorage on
// change and validated against the freshly loaded list on mount. Without
// this, every reload dropped the working context and disabled all
// profile-gated navigation until the user re-picked a profile.
const LAST_PROFILE_KEY = "careerflow_last_active_profile_id";

function readPersistedProfileId(profiles) {
  try {
    const raw = window.localStorage.getItem(LAST_PROFILE_KEY);
    if (raw == null) return null;
    const id = Number(raw);
    if (!Number.isFinite(id)) return null;
    return profiles.some((p) => Number(p.id) === id) ? id : null;
  } catch (_) {
    return null;
  }
}

function persistActiveProfileId() {
  try {
    const id = profileStore.activeProfileId;
    if (id == null) window.localStorage.removeItem(LAST_PROFILE_KEY);
    else window.localStorage.setItem(LAST_PROFILE_KEY, String(id));
  } catch (_) {
    // localStorage may be unavailable (tests / privacy mode) — non-fatal.
  }
}

/**
 * Load all student profiles
 */
export async function loadProfiles() {
  try {
    profileStore.profiles = await profileService.list();
    if (profileStore.activeProfileId == null) {
      const restored = readPersistedProfileId(profileStore.profiles);
      if (restored != null) profileStore.activeProfileId = restored;
    }
  } catch (e) {
    console.error("loadProfiles failed:", e);
  }
}

/**
 * Add a new student profile
 */
export async function addProfile(name, slug) {
  try {
    const created = await profileService.add(name, slug);
    await loadProfiles();
    profileStore.activeProfileId = created.id;
    persistActiveProfileId();
    return created;
  } catch (e) {
    reportError(e, "Could not add profile");
    throw e;
  }
}

/**
 * Select a profile (from ProfileManager cards or the initial picker).
 */
export function selectProfile(id) {
  profileStore.activeProfileId = id;
  persistActiveProfileId();
}

/**
 * Delete a profile by ID
 */
export async function deleteProfile(id) {
  try {
    await profileService.remove(id);
    if (profileStore.activeProfileId === id) {
      profileStore.activeProfileId = null;
      persistActiveProfileId();
    }
    await loadProfiles();
  } catch (e) {
    reportError(e, "Could not delete profile");
    throw e;
  }
}

/**
 * Export a profile to bundle
 */
export async function exportProfile(profile) {
  profileStore.porting = true;
  try {
    const res = await profileService.export(profile.id, profile.slug);
    if (res?.exported) {
      toast.success(`Exported "${profile.name}" to ${res.path}`, "Profile exported");
    }
    return res;
  } catch (e) {
    reportError(e, "Export failed");
    throw e;
  } finally {
    profileStore.porting = false;
  }
}

/**
 * Import a profile from bundle
 */
export async function importProfile() {
  profileStore.porting = true;
  try {
    const res = await profileService.import();
    if (res?.imported) {
      await loadProfiles();
      profileStore.activeProfileId = res.profile.profileId;
      persistActiveProfileId();
      toast.success(
        `Imported "${res.profile.name}" (${res.profile.resourceCount} resources)`,
        "Profile imported"
      );
    }
    return res;
  } catch (e) {
    reportError(e, "Import failed");
    throw e;
  } finally {
    profileStore.porting = false;
  }
}
