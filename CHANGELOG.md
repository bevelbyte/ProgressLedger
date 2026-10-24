# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Plan template save/load** — Reusable plan templates that persist across agent runs (`36002af`)
- **Agent error log** — UI showing failed runs with retry option (`b090807`)
- **Export agent session as JSON** — Export full conversation history (`f1e058d`)
- **First-time user onboarding tour** — 6-step guided tour for new users (`b090807`)
- **Hooks execution log** — Recent hook executions with filtering (`13b8f04`)
- **Tool approval queue** — Pending tool calls with approve/deny UI (`7bcefda`)
- **Provider health panel** — Live latency and error rate display including 429 responses (`7d6b3e0`)
- **Memory viewer panel** — Browse and search contextPacket memory (`f712579`)
- **Session timeline** — Full message stream with tool call cards (`5ebaadd`)
- **Keybindings help modal** — Keyboard shortcut reference (`386d7ba`)
- **Shell command history filter** — Filter by date and substring (`a60566b`)
- **Token budget panel** — Progress bar with live updates (`81d36d7`)
- **Project file diff view** — See modified/added/deleted files (`dac8bf6`)
- **Tool inventory panel** — Browse and filter all 16 agent tools (`194e6f3`)
- **Plugin inventory panel** — Browse, enable/disable, and reload plugins (`c0af87a`)
- **Skill inventory panel** — Browse and preview SKILL.md files (`12aefda`)
- **Default provider picker UI** — UI to choose the default LLM provider (`eb37e79`)
- **MCP curated server list** — Curated list of filesystem and fetch MCP servers (`2eff51c`)
- **Audit retention config** — Configurable retention policy (days and count) (`22d1c71`, `d99ac9d`)
- **Sub-agent run telemetry** — Track start/end/list of sub-agent runs (`69a5178`)
- **Plugin hot-reload** — Reload installed plugins without restarting the app (`5bb782e`)
- **Parallel DAG execution** — `pickNextReadyBatch` for true parallel agent execution (`0d89cc8`)
- **Live LLM smoke test** — Live provider test (`B007315`, `3bf2e8b`)
- **Marketplace browser UI** — Browse, install-local, install-git, enable/disable/uninstall (`6204de6`, `31785f6`)
- **MCP tool bridge** — Bridge MCP tools into the agent tool registry (`d78e415`)
- **Project intel integration** — Integrate relevantFiles into first user message (`ce9120d`)
- **Agent loop final round** — Emit final assistant round after verify-gate success (`5c6acc4`)
- **Project intelligence IPC + service** — IPC service for project intelligence data (`ec9a9e8`, `29832a4`)
- **Agent resume coverage** — Test coverage for resumeAgent (`5fe0adc`, `3627e61`)

### Changed

- **Pre-commit hook** — Parity check and fast test subset on staged changes (`0c06866`)

### Fixed

- **Audit temp dir race** — Fixed `withTempDir` async to avoid rm-before-flush race in audit.test.js (`4630f73`)
- **NAPI parity sync** — Rebuilt NAPI for pmGetAgent, hardened `check:esm`, synced tool count (`20953a4`)
- **Marketplace git install** — Removed stale 'git sources TODO' docstring, synced install-git tests (`9b242b7`)
- **SubAgentTree render** — Fixed duplicate render and added depth-bounded recursive tree (`29832a4`)

### Security

- **Content-Security-Policy** — Added strict CSP to main BrowserWindow (`2216c1e`)

---

## [Earlier]

### v3 — Project Mode (HEAD `0c06866`)

Full project-mode workspace shipped: sub-agent registry, skill inventory, plugin inventory, tool inventory, session timeline, memory viewer, token budget panel, provider health panel, hook execution log, tool approval queue, keybindings modal, shell history filter, file diff view, onboarding tour, agent error log, session export, plan templates, parallel DAG execution, audit retention config, plugin hot-reload, MCP tool bridge, MCP server list, project intelligence integration, and sub-agent telemetry.

### v2 — Core Engine

Core agent loop with parallel execution, provider abstraction, audit logging, skill system, test coverage, and NAPI parity.

### v1 — Foundation

Initial repository with basic project structure, agent skeleton, and tooling setup.
