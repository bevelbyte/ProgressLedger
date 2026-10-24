/** Public (non-secret) view of cloud connection state for the renderer. */
export function cloudPublicState(settings, extra = {}) {
  const cloud = settings.cloud;
  return {
    configured: Boolean(cloud?.url),
    provider: cloud?.provider ?? "webdav",
    url: cloud?.url ?? "",
    username: cloud?.username ?? "",
    lastSyncAt: cloud?.lastSyncAt ?? null,
    ...extra,
  };
}
