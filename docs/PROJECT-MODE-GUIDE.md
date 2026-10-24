# Project Mode User Guide

This guide describes every panel in Project Mode and what it is for. Open it from the workspace header whenever you forget what a panel does.

## Plan view

The plan view shows the steps the agent intends to take for the current objective. Each step has a status (pending, running, done, failed) and the agent asks for approval before any destructive action.

## Tool / Skill / Plugin inventory

Three side-by-side browsers list everything the agent can use. Tools are the actions it can take; skills are reusable instruction packs; plugins extend the platform with new tools, skills, and providers.

## Memory viewer

Shows what the agent has remembered across runs. Use it to inspect why a decision was made, pin important context, or clear stale entries so the agent starts fresh.

## Project diff

A unified diff between the working tree and the last committed state, scoped to the active project. Useful for reviewing exactly what an agent changed before approving.

## Token budget

Live counters for input, output, and total tokens used in the current session. Includes cost estimates and a warning when you approach your configured cap.

## Provider health

Status of every configured provider (latency, error rate, last failure). Switch the default provider here when one is misbehaving.

## Approval queue

A queue of tool calls waiting for your review. Approve or deny each request; the agent pauses until you respond.

## Hooks log

Every hook that ran during the session, in order: pre-tool, post-tool, and lifecycle hooks. Use this when debugging unexpected agent behaviour.

## Onboarding

A six-step guided tour shown the first time you visit Project Mode. Re-open it from the Help menu at any time.

## Session timeline

A chronological view of all events for the active agent: messages, tool calls, approvals, errors. Click an entry to jump back to that point in the conversation.

## Agent run history

List of every past agent run for the current project, with objective, duration, status, and token cost. Click one to view the full transcript.

## Recent errors

The last N errors from the active agent, with stack traces and the tool call that triggered them. A fast path for diagnosing failures without leaving Project Mode.

## Shell history

A searchable log of every shell command the agent has run. Filter by exit code, working directory, or command text to find a specific invocation.

## Plan templates

Reusable plan skeletons you can paste into a new objective. Templates save typing for common workflows like "refactor this file" or "add tests for module X".

## Session export

Download the active session as JSON, including every message, tool call, and approval decision. Useful for sharing a reproducible trace or for debugging later.

## Audit retention

A per-profile setting that controls how long agent audit logs and shell history are kept. Lower it for privacy; raise it for long-running investigations.