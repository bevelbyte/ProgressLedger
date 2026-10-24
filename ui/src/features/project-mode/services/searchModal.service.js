/**
 * SearchModal Service — aggregates searchable data from all existing IPC
 * sources and filters client-side. No new IPC channels are added; we reuse
 * agent:list-messages, memory:list, skills:list (via extensions),
 * tools:list (via projectTools), and plugins:list (via extensions).
 *
 * All searches are case-insensitive substring matches. The data sets are
 * small (typically <500 items total) so client-side filtering is fine.
 */

import { projectModeService } from "./projectMode.service.js";

/** Normalised hit shape returned to the UI. */
// { id, kind, title, subtitle, snippet, raw }

function match(haystack, needle) {
  return haystack.toLowerCase().includes(needle);
}

function snippetFrom(text, needle, span) {
  if (!text) return "";
  const str = String(text);
  const idx = str.toLowerCase().indexOf(needle);
  if (idx < 0) return str.length > span ? str.slice(0, span) + "..." : str;
  const start = Math.max(0, idx - 20);
  const prefix = start > 0 ? "..." : "";
  const end = Math.min(str.length, idx + span);
  const suffix = end < str.length ? "..." : "";
  return prefix + str.slice(start, end) + suffix;
}

export const searchModalService = {
  /**
   * Fetch everything in parallel. Returns { messages, memory, skills, tools, plugins }.
   * Any source that fails contributes an empty array — the modal degrades gracefully.
   */
  async fetchAll(profileId, agentId, projectId = null) {
    const [messagesRes, memoryRes, skillsRes, toolsRes, pluginsRes] = await Promise.allSettled([
      // Messages: only for the active agent (the common case).
      agentId != null
        ? projectModeService.listMessages(profileId, agentId)
        : Promise.resolve([]),
      // Memory.
      //
      // `memory.list(profileId, projectId, options)` — BOTH ids are required
      // and the main process proves project ownership before answering. Passing
      // `{}` in the projectId slot made the handler normalise it to 0 and
      // answer `invalid-input`, so the modal's memory group was permanently
      // empty. When the Runs console has no active project there is nothing
      // legitimate to list, so report that honestly instead of asking.
      (async () => {
        const m = window.progressLedger && window.progressLedger.memory;
        if (!m || typeof m.list !== "function") return { result: [] };
        if (typeof projectId !== "number") return { result: [] };
        return m.list(profileId, projectId, {});
      })(),
      // Skills
      (async () => {
        const e = window.progressLedger && window.progressLedger.extensions;
        if (!e || typeof e.listSkills !== "function") return { skills: [] };
        return e.listSkills();
      })(),
      // Tools
      (async () => {
        const p = window.progressLedger && window.progressLedger.projectTools;
        if (!p || typeof p.list !== "function") return { tools: [] };
        return p.list();
      })(),
      // Plugins.
      // `extensions.listPlugins(profileId)` is ownership-gated in the main
      // process (`plugins:list` -> assertProfileOwned), so calling it with no
      // argument was always rejected and the modal's plugin group was
      // permanently empty.
      (async () => {
        const e = window.progressLedger && window.progressLedger.extensions;
        if (!e || typeof e.listPlugins !== "function") return { plugins: [] };
        return e.listPlugins(profileId);
      })(),
    ]);

    const messages =
      messagesRes.status === "fulfilled" && Array.isArray(messagesRes.value)
        ? messagesRes.value
        : [];
    const memory =
      memoryRes.status === "fulfilled" &&
      memoryRes.value &&
      Array.isArray(memoryRes.value.result)
        ? memoryRes.value.result
        : [];
    const skills =
      skillsRes.status === "fulfilled" &&
      skillsRes.value &&
      Array.isArray(skillsRes.value.skills)
        ? skillsRes.value.skills
        : [];
    const tools =
      toolsRes.status === "fulfilled" && Array.isArray(toolsRes.value.tools)
        ? toolsRes.value.tools
        : [];
    const plugins =
      pluginsRes.status === "fulfilled" &&
      pluginsRes.value &&
      Array.isArray(pluginsRes.value.plugins)
        ? pluginsRes.value.plugins
        : [];

    return { messages, memory, skills, tools, plugins };
  },

  /**
   * Filter a fetched data-blob by `query`. Returns a flat array of hits
   * grouped logically by kind. Each hit carries enough info for the UI
   * to render a row and for the caller to act on selection.
   */
  search(data, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const hits = [];

    // Messages — search role + content + name
    for (const m of data.messages) {
      const hay = `${m.role || ""} ${m.content || ""} ${m.name || ""}`;
      if (match(hay, needle)) {
        hits.push({
          id: `msg-${m.id}`,
          kind: "message",
          title: m.role || "message",
          subtitle: m.name || "",
          snippet: snippetFrom(m.content, needle, 80),
          raw: m,
        });
      }
    }

    // Memory — search key + value + kind + scope
    for (const e of data.memory) {
      const hay = `${e.key || ""} ${e.value || ""} ${e.kind || ""} ${e.scope || ""}`;
      if (match(hay, needle)) {
        hits.push({
          id: `mem-${e.id}`,
          kind: "memory",
          title: e.key || e.kind || "memory",
          subtitle: e.scope || "",
          snippet: snippetFrom(e.value, needle, 80),
          raw: e,
        });
      }
    }

    // Skills — search id + name + description + triggers
    for (const s of data.skills) {
      const triggers = Array.isArray(s.triggers) ? s.triggers.join(" ") : "";
      const hay = `${s.id || ""} ${s.name || ""} ${s.description || ""} ${triggers}`;
      if (match(hay, needle)) {
        hits.push({
          id: `skill-${s.id}`,
          kind: "skill",
          title: s.name || s.id,
          subtitle: s.scope === "project" ? `project #${s.project_id}` : s.scope || "global",
          snippet: snippetFrom(s.description, needle, 80),
          raw: s,
        });
      }
    }

    // Tools — search name + description
    for (const t of data.tools) {
      const hay = `${t.name || ""} ${t.description || ""}`;
      if (match(hay, needle)) {
        hits.push({
          id: `tool-${t.name}`,
          kind: "tool",
          title: t.name,
          subtitle: t.permission || "",
          snippet: snippetFrom(t.description, needle, 80),
          raw: t,
        });
      }
    }

    // Plugins — search id + name + version
    for (const p of data.plugins) {
      const hay = `${p.id || ""} ${p.name || ""} ${p.version || ""}`;
      if (match(hay, needle)) {
        hits.push({
          id: `plugin-${p.id}`,
          kind: "plugin",
          title: p.name || p.id,
          subtitle: p.version || "",
          snippet: "",
          raw: p,
        });
      }
    }

    return hits;
  },
};
