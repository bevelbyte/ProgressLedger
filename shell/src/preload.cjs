const { contextBridge, ipcRenderer } = require("electron");

// NOTE: every channel listed here MUST have a matching ipcMain.handle in
// shell/src/ipc/*.js — scripts/check-ipc.mjs enforces this at test time.
const api = {
  runtime: {
    isE2E: process.argv.includes("--progressledger-v2-e2e"),
  },
  ping: () => ipcRenderer.invoke("core:ping"),

  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    add: (name, slug) => ipcRenderer.invoke("profiles:add", { name, slug }),
    remove: (id) => ipcRenderer.invoke("profiles:delete", id),
    export: (profileId, slug) => ipcRenderer.invoke("profiles:export", { profileId, slug }),
    import: () => ipcRenderer.invoke("profiles:import"),
  },

  academic: {
    tree: (profileId) => ipcRenderer.invoke("academic:tree", profileId),
    addTrack: (profileId, name) => ipcRenderer.invoke("academic:add-track", { profileId, name }),
    addSemester: (profileId, trackId, name) => ipcRenderer.invoke("academic:add-semester", { profileId, trackId, name }),
    addMilestone: (profileId, semesterId, title) => ipcRenderer.invoke("academic:add-milestone", { profileId, semesterId, title }),
    addSubject: (profileId, milestoneId, name, code) => ipcRenderer.invoke("academic:add-subject", { profileId, milestoneId, name, code }),
    updateSubject: (profileId, id, name, code) => ipcRenderer.invoke("academic:update-subject", { profileId, id, name, code }),
    deleteTrack: (profileId, id) => ipcRenderer.invoke("academic:delete-track", { profileId, id }),
    deleteSemester: (profileId, id) => ipcRenderer.invoke("academic:delete-semester", { profileId, id }),
    deleteMilestone: (profileId, id) => ipcRenderer.invoke("academic:delete-milestone", { profileId, id }),
    deleteSubject: (profileId, id) => ipcRenderer.invoke("academic:delete-subject", { profileId, id }),
    setSubjectStatus: (profileId, id, status) => ipcRenderer.invoke("academic:set-subject-status", { profileId, id, status }),
    setSemesterStatus: (profileId, id, status) => ipcRenderer.invoke("academic:set-semester-status", { profileId, id, status }),
  },

  resources: {
    list: ({ profileId, subjectId }) => ipcRenderer.invoke("resources:list", { profileId, subjectId }),
    get: ({ profileId, id }) => ipcRenderer.invoke("resources:get", { profileId, id }),
    addNote: (profileId, subjectId, title, content) =>
      ipcRenderer.invoke("resources:add-note", { profileId, subjectId, title, content }),
    updateNote: (profileId, id, title, content) =>
      ipcRenderer.invoke("resources:update-note", { profileId, id, title, content }),
    attachFile: ({ profileId, subjectId }) => ipcRenderer.invoke("resources:attach-file", { profileId, subjectId }),
    delete: (profileId, id) => ipcRenderer.invoke("resources:delete", { profileId, id }),
    // The renderer passes a *resource id*, not a path. The main process
    // resolves the path from the database (which is already constrained to
    // either the attachments root or a legacy absolute path the user
    // attached). This prevents a renderer compromise from coercing the
    // shell into opening arbitrary filesystem paths.
    openFile: ({ profileId, resourceId }) => ipcRenderer.invoke("resources:open-file", { profileId, resourceId }),
    search: (profileId, query) => ipcRenderer.invoke("resources:search", { profileId, query }),
    overview: ({ profileId, subjectId }) => ipcRenderer.invoke("subjects:overview", { profileId, subjectId }),
    semesterOverview: ({ profileId, semesterId }) => ipcRenderer.invoke("semester:overview", { profileId, semesterId }),
  },

  research: {
    listSources: (profileId) => ipcRenderer.invoke("research:list-sources", { profileId }),
    listCaptures: (profileId) => ipcRenderer.invoke("research:list-captures", { profileId }),
    saveSource: (profileId, pageId) => ipcRenderer.invoke("research:save-source", { profileId, pageId }),
    capture: (profileId, pageId, kind, text) => ipcRenderer.invoke("research:capture", { profileId, pageId, kind, text }),
    keptCount: (profileId, pageId) => ipcRenderer.invoke("research:kept-count", { profileId, pageId }),
    capturePage: (profileId, pageId) => ipcRenderer.invoke("research:capture-page", { profileId, pageId }),
    captureSelection: (profileId, pageId) => ipcRenderer.invoke("research:capture-selection", { profileId, pageId }),
    deleteSource: (profileId, sourceId) => ipcRenderer.invoke("research:delete-source", { profileId, sourceId }),
    deletePassage: (profileId, captureId) => ipcRenderer.invoke("research:delete-passage", { profileId, captureId }),
    search: (profileId, query, limit) => ipcRenderer.invoke("research:search", { profileId, query, limit }),
  },

  dashboard: {
    stats: (profileId) => ipcRenderer.invoke("dashboard:stats", profileId),
  },

  // Academic Focus — single batch read for the Dashboard's "Focus Now"
  // panel. Pure algorithm lives in
  // ui/src/features/dashboard/academic-focus.js; this is read-only data.
  focusSignals: {
    get: (profileId) => ipcRenderer.invoke("focus:signals", profileId),
  },

  deadlines: {
    list: (profileId) => ipcRenderer.invoke("deadlines:list", profileId),
    add: (profileId, subjectId, deadlineDate, category, title, notes) =>
      ipcRenderer.invoke("deadlines:add", { profileId, subjectId, deadlineDate, category, title, notes }),
    update: (profileId, id, deadlineDate, category, title, notes) =>
      ipcRenderer.invoke("deadlines:update", { profileId, id, deadlineDate, category, title, notes }),
    remove: (profileId, id) => ipcRenderer.invoke("deadlines:delete", { profileId, id }),
    setCompletion: (profileId, id, completed) => ipcRenderer.invoke("deadlines:set-completion", { profileId, id, completed }),
    paces: (profileId) => ipcRenderer.invoke("deadlines:paces", profileId),
  },

  mistakes: {
    list: ({ profileId, subjectId, mistakeType, limit } = {}) =>
      ipcRenderer.invoke("mistakes:list", { profileId, subjectId, mistakeType, limit }),
    add: (profileId, subjectId, questionText, mistakeType, correctApproach, tags) =>
      ipcRenderer.invoke("mistakes:add", { profileId, subjectId, questionText, mistakeType, correctApproach, tags }),
    update: (profileId, id, questionText, mistakeType, correctApproach, tags) =>
      ipcRenderer.invoke("mistakes:update", { profileId, id, questionText, mistakeType, correctApproach, tags }),
    remove: (profileId, id) => ipcRenderer.invoke("mistakes:delete", { profileId, id }),
    stats: (profileId) => ipcRenderer.invoke("mistakes:stats", profileId),
  },

  cards: {
    create: (profileId, subjectId, front, back) => ipcRenderer.invoke("cards:create", { profileId, subjectId, front, back }),
    due: (profileId) => ipcRenderer.invoke("cards:due", profileId),
    all: (profileId) => ipcRenderer.invoke("cards:all", profileId),
    review: (profileId, cardId, quality) => ipcRenderer.invoke("cards:review", { profileId, cardId, quality }),
    update: (profileId, cardId, subjectId, front, back) =>
      ipcRenderer.invoke("cards:update", { profileId, cardId, subjectId, front, back }),
    remove: (profileId, cardId) => ipcRenderer.invoke("cards:delete", { profileId, cardId }),
    stats: (profileId) => ipcRenderer.invoke("cards:stats", profileId),
  },

  links: {
    list: (profileId, subjectId) => ipcRenderer.invoke("links:list", { profileId, subjectId }),
    add: (profileId, subjectId, label, url) =>
      ipcRenderer.invoke("links:add", { profileId, subjectId, label, url }),
    update: (profileId, linkId, label, url) =>
      ipcRenderer.invoke("links:update", { profileId, linkId, label, url }),
    remove: (profileId, linkId) =>
      ipcRenderer.invoke("links:delete", { profileId, linkId }),
    setPrimary: (profileId, subjectId, linkId) =>
      ipcRenderer.invoke("links:set-primary", { profileId, subjectId, linkId }),
  },

  // Quick Note capture (Alt+N overlay). Persisted against the picked subject.
  notes: {
    onQuickNoteShortcut: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("shortcut:quick-note", handler);
      return () => ipcRenderer.removeListener("shortcut:quick-note", handler);
    },
  },

  backups: {
    get: () => ipcRenderer.invoke("backups:get"),
    chooseFolder: () => ipcRenderer.invoke("backups:choose-folder"),
    clearFolder: () => ipcRenderer.invoke("backups:clear-folder"),
    run: (profileId, slug) => ipcRenderer.invoke("backups:run", { profileId, slug }),
    inspect: (path) => ipcRenderer.invoke("backups:inspect", path),
    restore: (path) => ipcRenderer.invoke("backups:restore", path),
    openFolder: () => ipcRenderer.invoke("backups:open-folder"),
  },

  cloud: {
    get: () => ipcRenderer.invoke("cloud:get"),
    configure: (config) => ipcRenderer.invoke("cloud:configure", config),
    disconnect: () => ipcRenderer.invoke("cloud:disconnect"),
    upload: (profileId, slug) => ipcRenderer.invoke("cloud:upload", { profileId, slug }),
    uploadAll: (profiles) => ipcRenderer.invoke("cloud:upload-all", profiles),
    inspect: (remoteName) => ipcRenderer.invoke("cloud:inspect", remoteName),
    restore: (remoteName) => ipcRenderer.invoke("cloud:restore", remoteName),
  },

  sync: {
    getAutomation: () => ipcRenderer.invoke("sync:get-automation"),
    updateAutomation: (patch) => ipcRenderer.invoke("sync:update-automation", patch),
    runNow: () => ipcRenderer.invoke("sync:run-now"),
    onAutomationResult: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("sync:automation-result", handler);
      return () => ipcRenderer.removeListener("sync:automation-result", handler);
    },
  },

  diagnostics: {
    getReport: (options) => ipcRenderer.invoke("diagnostics:get-report", options ?? {}),
    exportReport: (options) => ipcRenderer.invoke("diagnostics:export-report", options ?? {}),
    openLogs: () => ipcRenderer.invoke("diagnostics:open-logs"),
    appendLog: (level, message, detail) => ipcRenderer.invoke("diagnostics:append-log", { level, message, detail }),
    readLog: () => ipcRenderer.invoke("diagnostics:read-log"),
  },

  update: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    onStatus: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("update:status", handler);
      return () => ipcRenderer.removeListener("update:status", handler);
    },
  },

  courses: {
    list: (profileId, semesterLabel) => ipcRenderer.invoke("courses:list", { profileId, semesterLabel }),
    add: (input) => ipcRenderer.invoke("courses:add", input),
    update: (input) => ipcRenderer.invoke("courses:update", input),
    remove: (profileId, courseId) => ipcRenderer.invoke("courses:delete", { profileId, courseId }),
    sgpa: (profileId, semesterLabel) => ipcRenderer.invoke("courses:sgpa", { profileId, semesterLabel }),
    cgpa: (profileId) => ipcRenderer.invoke("courses:cgpa", profileId),
    getGradeScale: (profileId) => ipcRenderer.invoke("courses:get-grade-scale", profileId),
    getDefaultGradeScale: () => ipcRenderer.invoke("courses:get-default-grade-scale"),
    validateGradeScale: (bands) => ipcRenderer.invoke("courses:validate-grade-scale", bands),
    setGradeScale: (profileId, bands) => ipcRenderer.invoke("courses:set-grade-scale", { profileId, bands }),
  },

  labs: {
    list: (profileId, subjectId) => ipcRenderer.invoke("labs:list", { profileId, subjectId }),
    add: (profileId, subjectId, experimentNo, title) =>
      ipcRenderer.invoke("labs:add", { profileId, subjectId, experimentNo, title }),
    update: (profileId, id, title, recordSubmitted, vivaDone, vivaScore, notes) =>
      ipcRenderer.invoke("labs:update", { profileId, id, title, recordSubmitted, vivaDone, vivaScore, notes }),
    remove: (profileId, id) => ipcRenderer.invoke("labs:delete", { profileId, id }),
    summary: (profileId) => ipcRenderer.invoke("labs:summary", profileId),
  },

  projects: {
    list: (profileId) => ipcRenderer.invoke("projects:list", profileId),
    add: (profileId, name, projectType, deadline, description) =>
      ipcRenderer.invoke("projects:add", { profileId, name, projectType, deadline, description }),
    update: (profileId, id, name, status, deadline, description) =>
      ipcRenderer.invoke("projects:update", { profileId, id, name, status, deadline, description }),
    remove: (profileId, id) => ipcRenderer.invoke("projects:delete", { profileId, id }),
  },

  projectTasks: {
    list: (profileId, projectId) => ipcRenderer.invoke("projectTasks:list", { profileId, projectId }),
    add: (profileId, projectId, title, priority, dueDate) =>
      ipcRenderer.invoke("projectTasks:add", { profileId, projectId, title, priority, dueDate }),
    update: (profileId, id, title, status, priority, dueDate, notes) =>
      ipcRenderer.invoke("projectTasks:update", { profileId, id, title, status, priority, dueDate, notes }),
    remove: (profileId, id) => ipcRenderer.invoke("projectTasks:delete", { profileId, id }),
  },

  formulas: {
    list: (profileId, subjectId, category) =>
      ipcRenderer.invoke("formulas:list", { profileId, subjectId, category }),
    add: (profileId, subjectId, title, latexContent, category) =>
      ipcRenderer.invoke("formulas:add", { profileId, subjectId, title, latexContent, category }),
    update: (profileId, id, title, latexContent, category) =>
      ipcRenderer.invoke("formulas:update", { profileId, id, title, latexContent, category }),
    remove: (profileId, id) => ipcRenderer.invoke("formulas:delete", { profileId, id }),
  },

  // Study sessions: logged study time per subject (feeds the study streak).
  sessions: {
    list: (profileId, limit) => ipcRenderer.invoke("sessions:list", { profileId, limit }),
    add: (profileId, subjectId, durationMinutes, startedAt, endedAt, notes) =>
      ipcRenderer.invoke("sessions:add", { profileId, subjectId, durationMinutes, startedAt, endedAt, notes }),
    remove: (profileId, id) => ipcRenderer.invoke("sessions:delete", { profileId, id }),
    stats: (profileId) => ipcRenderer.invoke("sessions:stats", profileId),
  },

  // Career planning: goals + roadmap milestones (SQLite-backed).
  career: {
    goals: (profileId) => ipcRenderer.invoke("career:goals", profileId),
    addGoal: (input) => ipcRenderer.invoke("career:add-goal", input),
    updateGoal: (input) => ipcRenderer.invoke("career:update-goal", input),
    setPrimaryGoal: (profileId, id) => ipcRenderer.invoke("career:set-primary-goal", { profileId, id }),
    deleteGoal: (profileId, id) => ipcRenderer.invoke("career:delete-goal", { profileId, id }),
    milestones: (profileId, goalId) => ipcRenderer.invoke("career:milestones", { profileId, goalId }),
    addMilestone: (input) => ipcRenderer.invoke("career:add-milestone", input),
    updateMilestone: (input) => ipcRenderer.invoke("career:update-milestone", input),
    setMilestoneCompletion: (profileId, id, completed) =>
      ipcRenderer.invoke("career:set-milestone-completion", { profileId, id, completed }),
    reorderMilestones: (profileId, goalId, orderedIds) =>
      ipcRenderer.invoke("career:reorder-milestones", { profileId, goalId, orderedIds }),
    deleteMilestone: (profileId, id) => ipcRenderer.invoke("career:delete-milestone", { profileId, id }),
    setMilestoneProject: (profileId, milestoneId, projectId) =>
      ipcRenderer.invoke("career:set-milestone-project", { profileId, milestoneId, projectId }),
    setMilestoneSubject: (profileId, milestoneId, subjectId) =>
      ipcRenderer.invoke("career:set-milestone-subject", { profileId, milestoneId, subjectId }),
  },

  // Progress Ledger-owned embedded browser (D2-D6 plan, Phase 1).
  //
  // The renderer names an OPAQUE page id (`bp-N`, minted in the main process)
  // and, for the layout declaration, integers. It cannot name a partition, a
  // path, a port, a token, a webContents or a session — the main process owns
  // every one of those. `onEvent` receives sanitized pushes; `state()` re-syncs
  // the whole mirror after a renderer reload, because browser pages live in main
  // and outlive this window.
  browser: {
    createPage: (options) => {
      // ONE options object, exactly the fields main validates. Only
      // defined values are copied into the payload (V2-31): an absent
      // restore or profile sends no field for it, and an unknown key
      // in options is dropped here and would be rejected by main.
      const payload = {};
      if (options?.profileId !== undefined) payload.profileId = options.profileId;
      if (options?.url !== undefined) payload.url = options.url;
      if (options?.restoreId !== undefined) payload.restoreId = options.restoreId;
      if (options?.browserProfileId !== undefined) payload.browserProfileId = options.browserProfileId;
      return ipcRenderer.invoke("browser:create-page", payload);
    },
    navigate: (pageId, url) => ipcRenderer.invoke("browser:navigate", { pageId, url }),
    // Open a local file: the main process shows the native dialog and
    // returns only the viewer URL (never a path). The dialog opens only
    // from the user's button/menu click that calls this.
    openLocalFile: (profileId) =>
      ipcRenderer.invoke("browser:open-local-file", { profileId }),
    reload: (pageId) => ipcRenderer.invoke("browser:reload", { pageId }),
    goBack: (pageId) => ipcRenderer.invoke("browser:go-back", { pageId }),
    goForward: (pageId) => ipcRenderer.invoke("browser:go-forward", { pageId }),
    navigation: (pageId) => ipcRenderer.invoke("browser:navigation", { pageId }),
    closePage: (pageId) => ipcRenderer.invoke("browser:close-page", { pageId }),
    listTabs: (profileId) => ipcRenderer.invoke("browser:list-tabs", { profileId }),
    // Phase 3B browser profiles. Returned profiles are stripped of
    // their password blob in main; the renderer never sees one.
    listProfiles: (profileId) => ipcRenderer.invoke("browser:list-profiles", { profileId }),
    createTempProfile: (profileId, displayName, color) =>
      ipcRenderer.invoke("browser:create-temp-profile", { profileId, displayName, color }),
    createProfile: (profileId, displayName, color, icon, notes) =>
      ipcRenderer.invoke("browser:create-profile", { profileId, displayName, color, icon, notes }),
    updateProfile: (profileId, localId, settings) =>
      ipcRenderer.invoke("browser:update-profile", { profileId, localId, settings }),
    deleteProfile: (profileId, localId, deleteLedger) =>
      ipcRenderer.invoke("browser:delete-profile", { profileId, localId, deleteLedger }),
    duplicateProfile: (profileId, localId) =>
      ipcRenderer.invoke("browser:duplicate-profile", { profileId, localId }),
    clearProfileData: (profileId, localId) =>
      ipcRenderer.invoke("browser:clear-profile-data", { profileId, localId }),
    testProxy: (profileId, localId, url) =>
      ipcRenderer.invoke("browser:test-proxy", { profileId, localId, url }),
    partitionSize: (profileId, localId) =>
      ipcRenderer.invoke("browser:partition-size", { profileId, localId }),
    setLiveCap: (profileId, cap) =>
      ipcRenderer.invoke("browser:set-live-cap", { profileId, cap }),
    getLiveCap: (profileId) => ipcRenderer.invoke("browser:live-cap", { profileId }),
    ledgerCountForProfile: (profileId, localId) =>
      ipcRenderer.invoke("browser:ledger-count-for-profile", { profileId, localId }),
    state: () => ipcRenderer.invoke("browser:state"),
    setBounds: (pageId, rect) => ipcRenderer.invoke("browser:set-bounds", { pageId, rect }),
    setVisible: (pageId, visible) =>
      ipcRenderer.invoke("browser:set-visible", { pageId, visible }),
    setOccluded: (occluded) => ipcRenderer.invoke("browser:set-occluded", { occluded }),
    // Managed downloads (approved decision D). Opaque ids and safe base names
    // only: no channel here accepts or returns a filesystem path, and none opens
    // a downloaded file. The destination is decided entirely in the main process.
    downloads: () => ipcRenderer.invoke("browser:downloads"),
    cancelDownload: (downloadId) =>
      ipcRenderer.invoke("browser:cancel-download", { downloadId }),
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("browser:on-event", handler);
      return () => ipcRenderer.removeListener("browser:on-event", handler);
    },
  },

  // System browser: subject links open outside the app. Only http(s)
  // URLs are accepted; the main process refuses everything else.
  system: {
    openExternal: (url) => ipcRenderer.invoke("system:open-external", { url }),
  },




  // Project Mode tool system. The renderer sees the safe metadata
  // (name, description, permission, inputSchema) and can invoke tools
  // by name + input. Approval-required tools return a `requiresApproval`
  // envelope; the UI shows a dialog and the renderer re-invokes with
  // the token returned by `approve()`. The projectRoot is owned by the
  // agent (main process), NEVER by the renderer.
  projectTools: {
    list: () => ipcRenderer.invoke("project:list-tools"),
    approve: (toolName, input) =>
      ipcRenderer.invoke("project:approve-tool", { toolName, input }),
    invoke: (toolName, input, options) => {
      const payload = {
        toolName,
        input: input || {},
        approvalToken: options && typeof options.approvalToken === "string" ? options.approvalToken : null,
        runId: options && typeof options.runId === "string" ? options.runId : null,
      };
      return ipcRenderer.invoke("project:invoke-tool", payload);
    },
  },

  // Skills + Plugins extension layer. The shell owns the registry and the
  // on-disk layout; the renderer just queries metadata and toggles.
  extensions: {
    listSkills: () => ipcRenderer.invoke("skills:list"),
    setSkillEnabled: (skillId, profileId, projectId, enabled) =>
      ipcRenderer.invoke("skills:set-enabled", {
        skillId,
        profileId,
        projectId: projectId == null ? null : projectId,
        enabled: !!enabled,
      }),
    // Read-only: returns the raw SKILL.md text for the given skill id so
    // the Skill Inventory panel can render a preview without exposing
    // any filesystem paths to the renderer.
    previewSkill: (skillId) =>
      ipcRenderer.invoke("skills:preview", { skillId: skillId || "" }),
    listPlugins: (profileId) => ipcRenderer.invoke("plugins:list", { profileId }),
    installLocalPlugin: (profileId, source, id) =>
      ipcRenderer.invoke("plugins:install-local", { profileId, source, id: id || null }),
    reloadPlugin: (id, profileId) =>
      ipcRenderer.invoke("plugins:reload", { profileId, id: id || "" }),
    enablePlugin: (id, profileId) =>
      ipcRenderer.invoke("plugins:enable", { profileId, id: id || "" }),
    disablePlugin: (id, profileId) =>
      ipcRenderer.invoke("plugins:disable", { profileId, id: id || "" }),
  },

  // Marketplace — discovery + install layer above Skills/Plugins.
  // Sources supported: `local` (a directory on disk) and `git` (clone a
  // public repo). The renderer passes strings; the main process owns
  // the install layout under <userData>/marketplace/.
  marketplace: {
    installLocal: (path) => ipcRenderer.invoke("marketplace:install-local", { path: path || "" }),
    installGit: (url, ref) =>
      ipcRenderer.invoke("marketplace:install-git", {
        url: url || "",
        ref: ref || "HEAD",
      }),
    list: () => ipcRenderer.invoke("marketplace:list"),
    get: (id) => ipcRenderer.invoke("marketplace:get", { id: id || "" }),
    enable: (id) => ipcRenderer.invoke("marketplace:enable", { id: id || "" }),
    disable: (id) => ipcRenderer.invoke("marketplace:disable", { id: id || "" }),
    uninstall: (id) => ipcRenderer.invoke("marketplace:uninstall", { id: id || "" }),
    update: (id) => ipcRenderer.invoke("marketplace:update", { id: id || "" }),
  },

  // Project Mode agent workspace: per-profile pm_projects / pm_agents /
  // pm_messages CRUD + the provider credentials store. The renderer
  // never sees the API key — `getProviderConfig` returns
  // { endpoint, model, hasKey } only.
  projectMode: {
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("project-mode:on-event", handler);
      return () => ipcRenderer.removeListener("project-mode:on-event", handler);
    },
    listProjects: (profileId) => ipcRenderer.invoke("project:list-projects", profileId),
    createProject: (input) =>
      ipcRenderer.invoke("project:create-project", input || {}),
    getProject: (profileId, projectId) =>
      ipcRenderer.invoke("project:get-project", { profileId, projectId }),
    deleteProject: (profileId, projectId) =>
      ipcRenderer.invoke("project:delete-project", { profileId, projectId }),

    listAgents: (profileId, projectId) =>
      ipcRenderer.invoke("project:list-agents", { profileId, projectId }),
    createAgent: (profileId, projectId, objective) =>
      ipcRenderer.invoke("project:create-agent", { profileId, projectId, objective }),
    getAgent: (profileId, agentId) =>
      ipcRenderer.invoke("project:get-agent", { profileId, agentId }),
    getPlan: (profileId, agentId) =>
      ipcRenderer.invoke("project:get-plan", { profileId, agentId }),
    listMessages: (profileId, agentId) =>
      ipcRenderer.invoke("project:list-messages", { profileId, agentId }),
    listMessagesPaginated: (profileId, agentId, limit, before) =>
      ipcRenderer.invoke("agent:list-messages", {
        profileId,
        agentId,
        limit: typeof limit === "number" ? limit : 50,
        before: typeof before === "number" ? before : null,
      }),
    getChildren: (profileId, parentAgentId) =>
      ipcRenderer.invoke("project:get-children", { profileId, parentAgentId }),
    setParent: (profileId, agentId, parentAgentId) =>
      ipcRenderer.invoke("project:set-parent", {
        profileId,
        agentId,
        parentAgentId: parentAgentId == null ? 0 : parentAgentId,
      }),

    startAgent: (profileId, agentId) =>
      ipcRenderer.invoke("project:start-agent", { profileId, agentId }),
    cancelAgent: (profileId, agentId) =>
      ipcRenderer.invoke("project:cancel-agent", { profileId, agentId }),
    getAgentRun: (profileId, agentId) =>
      ipcRenderer.invoke("project:get-agent-run", { profileId, agentId }),
    listSubagentRuns: (profileId, parentAgentId, limit) =>
      ipcRenderer.invoke("agent:list-subagent-runs", {
        profileId,
        parentAgentId: parentAgentId == null ? null : parentAgentId,
        limit: typeof limit === "number" ? limit : 200,
      }),
    listRecentAgentRuns: (profileId, limit) =>
      ipcRenderer.invoke("agent:list-recent", {
        profileId,
        limit: typeof limit === "number" ? limit : 50,
      }),
    // Resumable previous run: most-recent non-terminal agent for the
    // profile (running or paused when Progress Ledger was last closed).
    // Returns { ok, agent } where agent is null when nothing is
    // resumable. The renderer's ResumeBanner surfaces this on top of
    // Project Mode so the user can pick up where they left off.
    listResumableAgent: (profileId, limit) =>
      ipcRenderer.invoke("agent:list-resumable", {
        profileId: typeof profileId === "number" ? profileId : null,
        limit: typeof limit === "number" ? limit : 50,
      }),
    // Recent failed agent runs with the last status message attached.
    // `since` is an optional ISO-8601 timestamp; `limit` defaults to 50.
    listAgentErrors: (profileId, since, limit) =>
      ipcRenderer.invoke("agent:list-errors", {
        profileId,
        since: typeof since === "string" && since.length > 0 ? since : null,
        limit: typeof limit === "number" ? limit : 50,
      }),
    // Tool approval queue: list pending approvals and resolve them.
    listPendingApprovals: (profileId, agentId) =>
      ipcRenderer.invoke("agent:list-pending-approvals", {
        profileId: profileId == null ? null : profileId,
        agentId: agentId == null ? null : agentId,
      }),
    approveCall: (profileId, agentId, approvalId) =>
      ipcRenderer.invoke("agent:approve-call", {
        profileId: profileId == null ? null : profileId,
        agentId: agentId == null ? null : agentId,
        approvalId,
      }),
    denyCall: (profileId, agentId, approvalId) =>
      ipcRenderer.invoke("agent:deny-call", {
        profileId: profileId == null ? null : profileId,
        agentId: agentId == null ? null : agentId,
        approvalId,
      }),
    // Token budget (read-only): { current, cap, usedPct, lastUpdated }.
    // A cap of 0 means "no limit" (the project's config_json.token_budget
    // is 0 or unset); the UI reports usedPct as 0 in that case.
    getBudget: (profileId, agentId) =>
      ipcRenderer.invoke("agent:get-budget", { profileId, agentId }),

    // Provider health (read-only): one row per configured provider with
    // request/success/error counts, errorRate, avgLatencyMs and last429.
    // Recorded in-memory by shell/src/services/agent/provider.js; the
    // provider key is endpoint + model and never contains the apiKey.
    getProviderHealth: () =>
      ipcRenderer.invoke("provider:health"),

    getProviderConfig: (profileId, projectId) =>
      ipcRenderer.invoke("project:get-provider-config", { profileId, projectId }),
    setProviderConfig: (profileId, projectId, config) =>
      ipcRenderer.invoke("project:set-provider-config", {
        profileId,
        projectId,
        endpoint: config && config.endpoint,
        apiKey: config && config.apiKey,
        model: config && config.model,
      }),
    clearProviderConfig: (profileId, projectId) =>
      ipcRenderer.invoke("project:clear-provider-config", { profileId, projectId }),
    getDefaultProvider: (profileId, projectId) =>
      ipcRenderer.invoke("project:get-default-provider", { profileId, projectId }),
    setDefaultProvider: (profileId, projectId, providerId) =>
      ipcRenderer.invoke("project:set-default-provider", {
        profileId,
        projectId,
        providerId: providerId || "",
      }),
    exportSession: (profileId, agentId) =>
      ipcRenderer.invoke("agent:export-session", { profileId, agentId }),

    // Plan template library. Lets a user save a current plan under a name
    // and re-load it as the starter plan for a new agent run. Templates
    // are scoped by profile and the main process owns the SQL boundary.
    // `loadPlanTemplate` accepts either a row id or a name.
    savePlanTemplate: (profileId, name, description, planJson) =>
      ipcRenderer.invoke("plan:save-template", {
        profileId,
        name: name || "",
        description: typeof description === "string" ? description : null,
        planJson: typeof planJson === "string" ? planJson : "[]",
      }),
    listPlanTemplates: (profileId) =>
      ipcRenderer.invoke("plan:list-templates", { profileId }),
    loadPlanTemplate: (profileId, templateId, name) =>
      ipcRenderer.invoke("plan:load-template", {
        profileId,
        templateId: typeof templateId === "number" ? templateId : null,
        name: typeof name === "string" ? name : null,
      }),
    deletePlanTemplate: (profileId, templateId) =>
      ipcRenderer.invoke("plan:delete-template", { profileId, templateId }),
  },

  // Commands + Hooks extension layer. Commands are user-invokable verbs
  // typed as "/cmd arg1 arg2" in the input box. Hooks are plugin-side
  // lifecycle subscriptions. The dispatcher in ipc/commands-hooks.js
  // routes through the existing project-tools surface, so approval
  // semantics are preserved (e.g. /commit will not bypass the
  // exec_run approval gate).
  commands: {
    list: () => ipcRenderer.invoke("commands:list"),
    run: (profileId, commandLine, options) => {
      const payload = {
        profileId,
        projectId: options && typeof options.projectId === "number" ? options.projectId : null,
        agentId: options && typeof options.agentId === "number" ? options.agentId : null,
        commandLine: commandLine || "",
        approvalToken:
          options && typeof options.approvalToken === "string" ? options.approvalToken : null,
      };
      return ipcRenderer.invoke("commands:run", payload);
    },
  },
  hooks: {
    list: () => ipcRenderer.invoke("hooks:list"),
    listExecutions: (filters) => ipcRenderer.invoke("hooks:list-executions", filters || {}),
  },

  // Project Intelligence Layer — per-project file index + dependency
  // graph, persisted to a sidecar SQLite file. Renderer-initiated
  // calls are read-mostly; `index` triggers a (re)walk in the main
  // process and the result is cached there for subsequent reads.
  projectIntel: {
    index: (profileId, projectId, mode) =>
      ipcRenderer.invoke("project:intel:index", {
        profileId,
        projectId,
        mode: mode || "full",
      }),
    list: (profileId, projectId, options) =>
      ipcRenderer.invoke("project:intel:files", {
        profileId,
        projectId,
        max: options && typeof options.max === "number" ? options.max : undefined,
        ext: options && typeof options.ext === "string" ? options.ext : undefined,
        glob: options && typeof options.glob === "string" ? options.glob : undefined,
      }),
    neighbors: (profileId, projectId, filePath, depth) =>
      ipcRenderer.invoke("project:intel:neighbors", {
        profileId,
        projectId,
        filePath: filePath || "",
        depth: typeof depth === "number" ? depth : 1,
      }),
    relevant: (profileId, projectId, query, max) =>
      ipcRenderer.invoke("project:intel:relevant", {
        profileId,
        projectId,
        query: query || "",
        max: typeof max === "number" ? max : 20,
      }),
    stats: (profileId, projectId) =>
      ipcRenderer.invoke("project:intel:stats", { profileId, projectId }),
  },

  // Project Mode memory layer: persistent project-memory + retrieval-
  // based context selection. The renderer never sees the sidecar DB
  // path; persistence happens in the main process.
  memory: {
    projectSet: (profileId, projectId, kind, key, value, confidence) =>
      ipcRenderer.invoke("memory:project-set", {
        profileId,
        projectId,
        kind,
        key,
        value,
        confidence: typeof confidence === "number" ? confidence : 1.0,
      }),
    projectList: (profileId, projectId, options) =>
      ipcRenderer.invoke("memory:project-list", {
        profileId,
        projectId,
        kind: options && typeof options.kind === "string" ? options.kind : null,
        keyPrefix:
          options && typeof options.keyPrefix === "string" ? options.keyPrefix : null,
        limit: options && typeof options.limit === "number" ? options.limit : null,
      }),
    contextPacket: (profileId, projectId, objective, maxTokens) =>
      ipcRenderer.invoke("memory:context-packet", {
        profileId,
        projectId,
        objective: typeof objective === "string" ? objective : "",
        maxTokens: typeof maxTokens === "number" ? maxTokens : 2000,
      }),
    // Read-only combined view across project_memory + session_memory +
    // task_history for the MemoryViewer panel. agentId is optional;
    // scopes is an optional array narrowing the view (default: all 3).
    list: (profileId, projectId, options = {}) =>
      ipcRenderer.invoke("memory:list", {
        profileId,
        projectId,
        agentId: typeof options.agentId === "string" ? options.agentId : null,
        scopes: Array.isArray(options.scopes) ? options.scopes : null,
      }),
  },

  // Project Mode — diff view for the active project's working tree.
  // Calls shell_git_diff (the existing tool) through the main process.
  // The renderer never has a path; only (profileId, agentId, staged).
  diff: {
    workingTree: (profileId, agentId, options = {}) =>
      ipcRenderer.invoke("project:diff", {
        profileId,
        agentId,
        staged: typeof options.staged === "boolean" ? options.staged : false,
        maxBytes: typeof options.maxBytes === "number" ? options.maxBytes : 1_048_576,
      }),
  },

  // Per-sub-agent diff — shows what a finished child agent edited.
  // The renderer never has a path; it passes the (profileId, agentId,
  // runId) tuple plus the list of files the child reported.
  subagent: {
    diff: (profileId, callerAgentId, agentId, runId, files, options = {}) =>
      ipcRenderer.invoke("project:subagent-diff", {
        profileId,
        callerAgentId,
        agentId,
        runId,
        files: Array.isArray(files) ? files : [],
        maxBytes: typeof options.maxBytes === "number" ? options.maxBytes : 1_048_576,
      }),
  },

  // Security audit log (read-only from the renderer). The main process
  // owns the JSONL file; the renderer can list the most recent events
  // and export it. The retention POLICY is process-global (one JSONL, one
  // ring, one whole-file prune) — see the SF-3 note in shell/src/ipc/audit.js.
  // Every channel below is ownership-gated, so each call must carry a
  // profileId the caller owns; `days`/`count` are optional on setRetention.
  audit: {
    list: (options = {}) => ipcRenderer.invoke("audit:list", options || {}),
    listEvents: (options = {}) => ipcRenderer.invoke("audit:list-events", options || {}),
    export: (options = {}) => ipcRenderer.invoke("audit:export", options || {}),
    getRetention: (options = {}) => ipcRenderer.invoke("audit:get-retention", options || {}),
    setRetention: (options = {}) => ipcRenderer.invoke("audit:set-retention", options || {}),
  },

  // Goal Mode — first-class autonomous goal orchestration on top of the
  // proven agent engine. Goals persist independently of any single
  // agent run; the goal engine creates the linked pm_agents row when a
  // goal starts. Goal completion is grounded in the linked agent's
  // actual terminal state, never on model claims.
  goals: {
    create: (input) =>
      ipcRenderer.invoke("goal:create", input || {}),
    get: (profileId, goalId) =>
      ipcRenderer.invoke("goal:get", { profileId, goalId }),
    list: (profileId, options = {}) =>
      ipcRenderer.invoke("goal:list", {
        profileId,
        state: typeof options.state === "string" ? options.state : null,
        limit: typeof options.limit === "number" ? options.limit : 100,
      }),
    remove: (profileId, goalId) =>
      ipcRenderer.invoke("goal:delete", { profileId, goalId }),
    start: (profileId, goalId) =>
      ipcRenderer.invoke("goal:start", { profileId, goalId }),
    linkAgent: (profileId, goalId, agentId) =>
      ipcRenderer.invoke("goal:link-agent", { profileId, goalId, agentId }),
    cancel: (profileId, goalId) =>
      ipcRenderer.invoke("goal:cancel", { profileId, goalId }),
    listEvents: (profileId, goalId, limit) =>
      ipcRenderer.invoke("goal:list-events", {
        profileId,
        goalId,
        limit: typeof limit === "number" ? limit : 100,
      }),
    getAgentId: (profileId, goalId) =>
      ipcRenderer.invoke("goal:get-agent-id", { profileId, goalId }),
    reconcile: (profileId) =>
      ipcRenderer.invoke("goal:reconcile", { profileId }),
    recoverySweep: (profileId) =>
      ipcRenderer.invoke("goal:recovery-sweep", { profileId }),
    resume: (profileId, goalId, agentId) =>
      ipcRenderer.invoke("goal:resume", { profileId, goalId, agentId }),
    // Subscribe to engine-level events (started, terminal, cancelled).
    // Returns an unsubscribe function.
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("goal:event", handler);
      return () => ipcRenderer.removeListener("goal:event", handler);
    },
  },
};

/** Optional IPC debug tracing, enabled via localStorage["progressledger_v2_debug_mode"]. */
function wrapApi(obj, path = "") {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const currentPath = path ? `${path}.${key}` : key;
    if (typeof val === "function") {
      if (
        currentPath === "diagnostics.appendLog" ||
        currentPath === "diagnostics.readLog" ||
        key.startsWith("on")
      ) {
        continue;
      }
      obj[key] = async function (...args) {
        let isDebug = false;
        try {
          isDebug = localStorage.getItem("progressledger_v2_debug_mode") === "true";
        } catch (e) {}

        if (!isDebug) {
          return val.apply(this, args);
        }

        try {
          ipcRenderer
            .invoke("diagnostics:append-log", {
              level: "info",
              message: `[IPC Request] Start ${currentPath}`,
              detail: { component: "IPC", function: currentPath, event: "start", parameters: args },
            })
            .catch(() => {});
        } catch (e) {
          console.error(e);
        }

        const start = performance.now();
        try {
          const result = await val.apply(this, args);
          const duration = performance.now() - start;
          ipcRenderer
            .invoke("diagnostics:append-log", {
              level: "info",
              message: `[IPC Response] End ${currentPath}${duration > 500 ? " [SLOW OPERATION]" : ""} (${duration.toFixed(2)}ms)`,
              detail: { component: "IPC", function: currentPath, event: "end", duration: `${duration.toFixed(2)}ms`, success: true },
            })
            .catch(() => {});
          return result;
        } catch (e) {
          const duration = performance.now() - start;
          ipcRenderer
            .invoke("diagnostics:append-log", {
              level: "error",
              message: `[IPC Response] Fail ${currentPath} (${duration.toFixed(2)}ms): ${e.message}`,
              detail: { component: "IPC", function: currentPath, event: "fail", error: e.message, stack: e.stack || "" },
            })
            .catch(() => {});
          throw e;
        }
      };
    } else if (typeof val === "object" && val !== null) {
      wrapApi(val, currentPath);
    }
  }
}

wrapApi(api);
contextBridge.exposeInMainWorld("progressLedger", api);
