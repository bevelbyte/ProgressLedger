/**
 * Shared bundle-inspection helper: reads a .cfprofile manifest and reports
 * whether restoring it would collide with an existing local profile.
 */
export function inspectBundleConflicts(core, path) {
  const info = core.inspectProfileBundle(path);
  const profiles = core.getProfiles();
  const sameSlug = profiles.find((p) => p.slug === info.slug);
  const sameName = profiles.find((p) => p.name === info.name);
  return {
    ...info,
    conflicts: {
      sameSlug: sameSlug ? { id: sameSlug.id, name: sameSlug.name, slug: sameSlug.slug } : null,
      sameName: sameName ? { id: sameName.id, name: sameName.name, slug: sameName.slug } : null,
    },
    resolution:
      sameSlug || sameName
        ? "Restore will create a new profile and auto-resolve slug collisions."
        : "No local profile conflicts detected.",
  };
}
