---
name: goal-keeper
description: Open the Goal Keeper control panel or change its global and per-conversation goal continuation switches.
---

Use the `goal_keeper` MCP tools to inspect settings, open the panel, or change a switch requested by the user. For a conversation action, use the current `CODEX_THREAD_ID` or the exact conversation id supplied by the user.

`goal_keeper_open_panel` opens a panel inside that conversation. `goal_keeper_switch` accepts `globalEnabled` and/or `threadId` plus `mode` (`inherit`, `on`, `off`). An explicit conversation mode takes precedence over the global default. Report the effective setting returned by the tool.

The local service continues only `blocked` goals and stops monitoring a completed goal. It preserves the conversation's model and permissions and waits while a turn runs or a user request is pending. Goal Keeper does not grant additional permissions for the goal's work.

If MCP has not refreshed yet, use the installed plugin's `src/cli.mjs` with Node. `panel`, `on`, `off`, `thread <id> <mode>`, and `status` provide the same controls. Locate the installed plugin through its marketplace cache; do not read or print authentication files.
