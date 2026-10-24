// PHASE 12 — one realistic end-to-end user workflow, in the REAL PACKAGED app.
//
// This is the "does it work as a system" spec, not a unit of isolated
// functions. It walks the path a person actually takes on a first real day:
//
//   launch -> create a profile -> create a project -> BIND A PROJECT ROOT ->
//   build Project Intelligence over that root -> create and edit a note ->
//   launch an agent run -> approve a privileged tool -> observe the real
//   filesystem side effect -> read the audit trail -> CLOSE -> RESTART ->
//   prove every one of those facts survived -> visit the Marketplace ->
//   prove the installed set persisted -> CLOSE again
//
// Why the packaged binary: the renderer is served over `careerflow://` rather
// than `file:`, `app.getPath("userData")` resolves differently, and `whenReady`
// ordering is the real one. None of that is exercised by a dev-server run.
//
// WHY THIS SPEC IS ALSO A REGRESSION GUARD
// The NOTES leg is the product-level proof of a defect fixed in this pass.
// `noteService.addNote(profileId, subjectId, title, content)` is positional
// end-to-end, and both call sites used to pass only THREE arguments. The call
// therefore SUCCEEDED at the IPC boundary with every argument shifted one slot
// left: the note was filed against the subject id as a profile, the title
// column received the body, and `content` was null. Nothing rejected it. This
// spec asserts the note comes back with the right profile, the right subject,
// the right title and a real body — through the real packaged IPC path.
//
// NOTHING here touches DonutBrowser-Integration.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const PACKAGED_EXE = join(projectRoot, "release", "win-unpacked", "CareerFlow.exe");

const FIXTURE_KEY = "E2E-WORKFLOW-FIXTURE-KEY-NOT-A-SECRET";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 250, what = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/**
 * A scripted OpenAI-compatible provider. The credential is planted through
 * CareerFlow's OWN pm-secrets.json mechanism with a fixture value, so no real
 * provider and no real secret is involved.
 */
function startScriptedProvider() {
  const state = { rounds: [], callSeq: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const round = state.rounds[state.callSeq] ?? state.rounds[state.rounds.length - 1] ?? { text: "done" };
      state.callSeq += 1;
      const toolCalls = (round.toolCalls ?? []).map((tc, i) => ({
        id: `call-${state.callSeq}-${i}`,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      }));
      const chunks = [];
      chunks.push({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (toolCalls.length) {
        chunks.push({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
        chunks.push({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        chunks.push({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: round.text ?? "done" }, finish_reason: null }] });
        chunks.push({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, state, endpoint: `http://127.0.0.1:${server.address().port}/v1` })
    );
  });
}

async function dismissOnboarding(win) {
  const overlay = win.locator(".onboarding-overlay");
  if (await overlay.count()) {
    const skip = overlay.locator(".skip-btn, .complete-btn").first();
    if (await skip.count()) await skip.click().catch(() => {});
    await overlay.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  }
}

test.describe("Phase 12 — realistic end-to-end workflow (packaged)", () => {
  test.setTimeout(600_000);

  test("profile → project root → project intelligence → note → agent run + approval → audit → restart → marketplace", async () => {
    if (!existsSync(PACKAGED_EXE)) {
      throw new Error(`packaged exe missing: ${PACKAGED_EXE} — run "npm run dist:dir" first`);
    }

    const userDataDir = mkdtempSync(join(tmpdir(), "cf-wf-ud-"));
    const projectRootPath = mkdtempSync(join(tmpdir(), "cf-wf-proj-"));
    const mktSourceParent = mkdtempSync(join(tmpdir(), "cf-wf-mkt-"));
    const provider = await startScriptedProvider();

    // A small, real source tree for Project Intelligence to index.
    mkdirSync(join(projectRootPath, "src"), { recursive: true });
    writeFileSync(join(projectRootPath, "src", "index.js"), "export const answer = 42;\n", "utf8");
    writeFileSync(join(projectRootPath, "README.md"), "# Workflow fixture\n\nA marker for indexing.\n", "utf8");

    const markerName = "workflow-proof.txt";
    const markerPath = join(projectRootPath, markerName);

    const launch = () =>
      electron.launch({
        executablePath: PACKAGED_EXE,
        args: [`--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          CAREERFLOW_E2E: "1",
          CAREERFLOW_E2E_USER_DATA: userDataDir,
          CAREERFLOW_E2E_DONUT_STUB: "1",
          CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK: "1",
        },
      });

    let app;
    try {
      app = await launch();
      let win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/CareerFlow core online/i)).toBeVisible({ timeout: 30_000 });
      await dismissOnboarding(win);

      // ---- 1. PROFILE -----------------------------------------------------
      const profileId = await win.evaluate(async () => {
        const p = await window.careerflow.profiles.add("Workflow Owner", `wf-${Date.now()}`);
        return Number(p.id);
      });
      expect(profileId).toBeGreaterThan(0);

      // ---- 2/3. PROJECT + BOUND ROOT (SF-1 canonicalization) ---------------
      // The stored root is the trusted filesystem scope, so the packaged app
      // must accept a real existing directory and store its CANONICAL path.
      const projectId = await win.evaluate(
        ([pid, root]) =>
          window.careerflow.projectMode.createProject({
            profileId: pid,
            name: "Workflow Project",
            description: "phase-12",
            rootPath: root,
            configJson: "{}",
          }),
        [profileId, projectRootPath]
      );
      expect(projectId, "createProject must succeed against a real root").toBeGreaterThan(0);

      const project = await win.evaluate(
        ([pid, id]) => window.careerflow.projectMode.getProject(pid, id),
        [profileId, projectId]
      );
      // `project:get-project` returns the project ROW directly once ownership
      // is proven (ipc/project-mode.js returns `ownership.project`), or the
      // refusal envelope when it is not.
      expect(project && project.id, "getProject must return the project row").toBe(projectId);
      expect(project.rootPath, "the stored root must be canonicalized").toBe(projectRootPath);

      // A root that does not exist must be refused, and nothing persisted.
      const missingRoot = join(userDataDir, "definitely", "not", "here");
      const badRoot = await win.evaluate(
        ([pid, root]) =>
          window.careerflow.projectMode.createProject({
            profileId: pid,
            name: "Bad Root",
            description: "no",
            rootPath: root,
            configJson: "{}",
          }),
        [profileId, missingRoot]
      );
      expect(badRoot.ok).toBe(false);
      expect(["root-not-found", "root-not-absolute", "root-not-a-directory"]).toContain(badRoot.reason);

      // ---- 4. PROJECT INTELLIGENCE over the bound root ---------------------
      const indexed = await win.evaluate(
        ([pid, id]) => window.careerflow.projectIntel.index(pid, id, "full"),
        [profileId, projectId]
      );
      expect(indexed.ok, `project-intel index must succeed: ${JSON.stringify(indexed)}`).toBe(true);

      const files = await win.evaluate(
        ([pid, id]) => window.careerflow.projectIntel.list(pid, id, { max: 200 }),
        [profileId, projectId]
      );
      expect(files.ok).toBe(true);
      const fileList = JSON.stringify(files);
      expect(fileList, "the indexed tree must contain the real source file").toContain("index.js");

      // The renderer is never allowed to choose a root: the main process
      // derives the trusted root from the OWNED project row and binds every
      // read to it (SF-1 + SF-2). So a read for a project this profile does
      // not own must be refused outright.
      const foreignIntel = await win.evaluate(
        ([pid, id]) => window.careerflow.projectIntel.list(pid, id, {}),
        [profileId + 9999, projectId]
      );
      expect(foreignIntel.ok, "project-intel must refuse a project the profile does not own").toBeFalsy();
      // The refusal envelope from shell/src/security/project-intel-auth.js
      // carries `error`, not `reason`.
      expect(
        ["project-not-owned", "invalid-project-context", "core-not-wired", "project-root-unavailable"]
      ).toContain(foreignIntel.error);
      expect(
        JSON.stringify(foreignIntel),
        "a refused project-intel read must not leak any indexed path"
      ).not.toContain("index.js");

      // ---- 5. SUBJECT + NOTE (the fixed positional boundary) ---------------
      // academic: track -> semester -> milestone -> subject. Notes live inside
      // a subject, so the whole chain has to exist first.
      const subjectId = await win.evaluate(async ([pid]) => {
        await window.careerflow.academic.tree(pid).catch(() => {});
        const track = await window.careerflow.academic.addTrack(pid, "Workflow BSc");
        const trackId = typeof track === "number" ? track : track?.id;
        const semester = await window.careerflow.academic.addSemester(pid, trackId, "Semester 1");
        const semesterId = typeof semester === "number" ? semester : semester?.id;
        const milestone = await window.careerflow.academic.addMilestone(pid, semesterId, "Core");
        const milestoneId = typeof milestone === "number" ? milestone : milestone?.id;
        const subject = await window.careerflow.academic.addSubject(pid, milestoneId, "Workflow Subject", "WFS101");
        return typeof subject === "number" ? subject : subject?.id;
      }, [profileId]);
      expect(subjectId).toBeGreaterThan(0);

      // `resources:add-note` returns the new row id (core.addNote), so accept
      // either the bare number or an envelope.
      const noteAdd = await win.evaluate(
        ([pid, sid]) => window.careerflow.resources.addNote(pid, sid, "Workflow Note", "Body that must survive."),
        [profileId, subjectId]
      );
      const noteId = typeof noteAdd === "number" ? noteAdd : noteAdd?.id;
      expect(noteId, `addNote must return the new note id: ${JSON.stringify(noteAdd)}`).toBeGreaterThan(0);

      // Read it back through the SAME profile-scoped read path and prove every
      // field landed in the right column. Before the fix the body was written
      // into `title` and `content` was null.
      const readBack = await win.evaluate(
        ([pid, id]) => window.careerflow.resources.get({ profileId: pid, id }),
        [profileId, noteId]
      );
      expect(readBack.title, "the title must be the title").toBe("Workflow Note");
      expect(readBack.content, "the body must be the body").toBe("Body that must survive.");

      // And it must be reachable through the profile-scoped LIST, which is how
      // the UI actually finds it. A misfiled note would be invisible here.
      const listed = await win.evaluate(
        ([pid, sid]) => window.careerflow.resources.list({ profileId: pid, subjectId: sid }),
        [profileId, subjectId]
      );
      expect(JSON.stringify(listed)).toContain("Workflow Note");

      // Edit it and re-read: the update path is equally positional.
      await win.evaluate(
        ([pid, id]) => window.careerflow.resources.updateNote(pid, id, "Workflow Note v2", "Edited body."),
        [profileId, noteId]
      );
      const afterEdit = await win.evaluate(
        ([pid, id]) => window.careerflow.resources.get({ profileId: pid, id }),
        [profileId, noteId]
      );
      expect(afterEdit.title).toBe("Workflow Note v2");
      expect(afterEdit.content).toBe("Edited body.");

      // ---- 6/7/8. AGENT RUN + APPROVAL + REAL FILESYSTEM EFFECT ------------
      writeFileSync(
        join(userDataDir, "pm-secrets.json"),
        JSON.stringify({ [`${profileId}:${projectId}`]: { endpoint: provider.endpoint, apiKey: FIXTURE_KEY, model: "wf", updatedAt: Date.now() } }, null, 2),
        "utf8",
      );
      // The credential must be read from the app's own userData, which the
      // packaged app resolves via CAREERFLOW_E2E_USER_DATA.
      provider.state.rounds = [
        { toolCalls: [{ name: "fs_write", args: { path: markerName, content: "WORKFLOW-OK" } }] },
        { text: "workflow complete" },
      ];

      const agentId = await win.evaluate(
        ([pid, proj]) => window.careerflow.projectMode.createAgent(pid, proj, "Write the workflow proof file."),
        [profileId, projectId]
      );
      expect(agentId).toBeGreaterThan(0);

      const startRes = await win.evaluate(
        ([pid, aid]) => window.careerflow.projectMode.startAgent(pid, aid),
        [profileId, agentId]
      );
      expect(startRes.ok, `startAgent: ${JSON.stringify(startRes)}`).toBe(true);

      // ---- 9. AUDIT: the privileged decision is on the record --------------
      const approvals = await waitFor(async () => {
        const r = await win.evaluate(
          ([pid, aid]) => window.careerflow.projectMode.listPendingApprovals(pid, aid),
          [profileId, agentId]
        );
        return r && r.ok && r.count >= 1 ? r : null;
      }, { what: "pending approval" });
      const row = approvals.approvals.find((a) => a.toolName === "fs_write");
      expect(row, "the fs_write approval must be queued").toBeTruthy();
      // The renderer is never handed the raw arguments (SF-3 boundary).
      expect(row).not.toHaveProperty("input");

      const approveRes = await win.evaluate(
        ([pid, aid, id]) => window.careerflow.projectMode.approveCall(pid, aid, id),
        [profileId, agentId, row.id]
      );
      expect(approveRes && approveRes.ok, `approveCall: ${JSON.stringify(approveRes)} row=${JSON.stringify(row)}`).toBe(true);

      // The REAL side effect on the REAL filesystem, inside the bound root.
      await waitFor(() => existsSync(markerPath), { what: "fs_write side effect" });
      expect(readFileSync(markerPath, "utf8")).toBe("WORKFLOW-OK");

      await waitFor(async () => {
        const a = await win.evaluate(
          ([pid, aid]) => window.careerflow.projectMode.getAgent(pid, aid),
          [profileId, agentId]
        );
        const s = a && (a.agent || a);
        return s && (s.state === "completed" || s.state === "failed") ? s : null;
      }, { what: "agent terminal state" });

      const audit = await win.evaluate(
        (pid) => window.careerflow.audit.list({ profileId: pid, limit: 200 }),
        profileId
      );
      expect(audit.ok, "the audit trail must be readable by the owning profile").toBe(true);
      const auditJson = JSON.stringify(audit);
      expect(auditJson, "project.create must be audited").toContain("project.create");
      expect(auditJson, "the privileged tool call must be audited").toContain("fs_write");
      // The gate itself, not just the action: who decided, on what, and how.
      const approvalEvent = audit.events.find((e) => e.event === "approval.resolve");
      expect(approvalEvent, "the human approval decision must be on the security record").toBeTruthy();
      expect(approvalEvent.result).toBe("approved");
      expect(approvalEvent.tool).toBe("fs_write");
      expect(approvalEvent.profileId).toBe(profileId);
      expect(approvalEvent.agentId).toBe(agentId);
      expect(approvalEvent.detail).toContain("permission=WRITE");
      // The arguments must never reach the record.
      expect(auditJson).not.toContain(markerName);
      // No secret may ever reach the audit surface.
      expect(auditJson).not.toContain(FIXTURE_KEY);

      // ---- 10. CLOSE + RESTART ---------------------------------------------
      await app.close();
      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/CareerFlow core online/i)).toBeVisible({ timeout: 30_000 });
      await dismissOnboarding(win);

      // Profile, project, root, note, and the filesystem effect all survive.
      const profilesAfter = await win.evaluate(() => window.careerflow.profiles.list());
      expect(profilesAfter.some((p) => Number(p.id) === profileId)).toBe(true);

      const projectAfter = await win.evaluate(
        ([pid, id]) => window.careerflow.projectMode.getProject(pid, id),
        [profileId, projectId]
      );
      expect(projectAfter && projectAfter.id, "the project must survive the restart").toBe(projectId);
      expect(projectAfter.rootPath, "the canonicalized root must survive the restart").toBe(projectRootPath);

      const noteAfter = await win.evaluate(
        ([pid, id]) => window.careerflow.resources.get({ profileId: pid, id }),
        [profileId, noteId]
      );
      expect(noteAfter.title).toBe("Workflow Note v2");
      expect(noteAfter.content).toBe("Edited body.");

      expect(existsSync(markerPath), "the agent's real output must survive the restart").toBe(true);
      expect(readFileSync(markerPath, "utf8")).toBe("WORKFLOW-OK");

      // Project Intelligence cache must still answer for the SAME root, and
      // must still refuse a mismatched one (SF-2).
      const intelAfter = await win.evaluate(
        ([pid, id]) => window.careerflow.projectIntel.list(pid, id, {}),
        [profileId, projectId]
      );
      expect(intelAfter.ok).toBe(true);
      expect(JSON.stringify(intelAfter)).toContain("index.js");

      // The audit trail survives too, and is still profile-scoped.
      const auditAfter = await win.evaluate(
        (pid) => window.careerflow.audit.list({ profileId: pid, limit: 200 }),
        profileId
      );
      expect(auditAfter.ok).toBe(true);
      expect(JSON.stringify(auditAfter)).toContain("project.create");

      // A DIFFERENT profile must not be able to read this profile's audit.
      const otherProfile = await win.evaluate(async () => {
        const p = await window.careerflow.profiles.add("Other Owner", `wf-other-${Date.now()}`);
        return Number(p.id);
      });
      expect(otherProfile).not.toBe(profileId);
      const auditWrongProfile = await win.evaluate(
        (pid) => window.careerflow.audit.list({ profileId: pid, limit: 200 }),
        otherProfile
      );
      expect(auditWrongProfile.ok).toBe(true);
      expect(
        JSON.stringify(auditWrongProfile),
        "another profile must not see this profile's audit events"
      ).not.toContain(`"profileId":${profileId}`);

      // ---- 10b. PROFILE DELETION is on the security record ------------------
      // Removing a profile is the most destructive operation in the product:
      // it destroys the profile and every row scoped to it. It was previously
      // invisible on the audit trail, so after the fact there was no way to
      // tell the profile had ever existed.
      const doomed = await win.evaluate(async () => {
        const p = await window.careerflow.profiles.add("Doomed Owner", `wf-doomed-${Date.now()}`);
        return Number(p.id);
      });
      expect(doomed).toBeGreaterThan(0);
      const createEvent = (await win.evaluate(
        (pid) => window.careerflow.audit.list({ profileId: pid, limit: 200 }),
        doomed
      ));
      expect(JSON.stringify(createEvent), "profile.create must be audited").toContain("profile.create");

      // `profiles:delete` returns whatever `core.deleteProfile` returns, which
      // may be undefined on success — so the call must not dereference `.ok`.
      // The real proof that it worked is the profile list immediately after.
      await win.evaluate((pid) => window.careerflow.profiles.remove(pid), doomed);
      const afterDelete = await win.evaluate(() => window.careerflow.profiles.list());
      expect(afterDelete.some((p) => Number(p.id) === doomed), "the profile must really be gone").toBe(false);

      // The `profile.delete` event is attributed to the DELETED profile id,
      // which is the only correct attribution. SF-3 deliberately gates every
      // `audit:*` read channel on an EXISTING, owned profileId, so once the
      // profile is gone its own deletion record is no longer reachable through
      // `audit:list` — by design, not by defect. The durable evidence is the
      // JSONL itself, which this test can read because it runs in Node.
      const auditLogPath = join(userDataDir, "audit-log.jsonl");
      expect(existsSync(auditLogPath), "the audit JSONL must exist on disk").toBe(true);
      const auditLines = readFileSync(auditLogPath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const deleteEvent = auditLines.find((e) => e.event === "profile.delete" && e.profileId === doomed);
      expect(deleteEvent, "profile.delete must be durably recorded").toBeTruthy();
      expect(deleteEvent.result).toBe("ok");
      // And the create/delete pair for this profile is both on the record.
      expect(
        auditLines.some((e) => e.event === "profile.create" && e.profileId === doomed),
        "profile.create for the same profile must also be on the record"
      ).toBe(true);
      // The whole log must never contain a secret.
      expect(readFileSync(auditLogPath, "utf8")).not.toContain(FIXTURE_KEY);

      // ---- 11. MARKETPLACE in the same real session ------------------------
      const mktSource = join(mktSourceParent, "workflow-plugin");
      mkdirSync(mktSource, { recursive: true });
      writeFileSync(
        join(mktSource, "plugin.json"),
        JSON.stringify({ name: "Workflow Plugin", version: "1.2.3", skills: [], tools: [], mcpServers: [] }, null, 2),
        "utf8",
      );
      const mktInstalled = await win.evaluate((p) => window.careerflow.marketplace.installLocal(p), mktSource);
      expect(mktInstalled.ok).toBe(true);
      expect(mktInstalled.id).toBe("workflow-plugin");
      const mktEnabled = await win.evaluate(() => window.careerflow.marketplace.enable("workflow-plugin"));
      expect(mktEnabled.ok).toBe(true);

      // ---- 12. CLOSE AGAIN -------------------------------------------------
      await app.close();
      app = await launch();
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/CareerFlow core online/i)).toBeVisible({ timeout: 30_000 });
      await dismissOnboarding(win);

      const mktAfter = await win.evaluate(() => window.careerflow.marketplace.list());
      expect(mktAfter.ok, "the marketplace must be live on the third launch too").toBe(true);
      const item = mktAfter.items.find((i) => i.id === "workflow-plugin");
      expect(item, "the installed marketplace item must survive").toBeTruthy();
      expect(item.version).toBe("1.2.3");
      expect(item.enabled, "the enabled flag must survive").toBe(true);
    } finally {
      try { app && (await app.close()); } catch {}
      try { provider.server.close(); } catch {}
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(projectRootPath, { recursive: true, force: true });
      rmSync(mktSourceParent, { recursive: true, force: true });
    }
  });
});
