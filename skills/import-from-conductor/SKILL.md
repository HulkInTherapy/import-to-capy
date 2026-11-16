---
name: import-from-conductor
description: Import a repository and its workspaces from Conductor (the Mac app that runs coding agents in git worktrees) into Capy, or set it up to run in both. Use when the user says "import from conductor", "move my Conductor setup", "migrate from Conductor", or the repo has conductor.json, .conductor/settings.toml or .worktreeinclude. Converts setup, run and archive scripts into Capy's .capy/setup.json via a pull request, lets the user pick workspaces in plain words ("latest 3", "unfinished", "everything"), and turns each into a Capy thread with a redacted chat handoff. Read-only on Conductor; never reads secret values.
---

# Import from Conductor

Follow the flow in the `import` skill (detect → scan → pick → chats once → preview → one confirmation → import → summary) with `--source conductor`. This file adds the Conductor specifics: the setup conversion and the workspace details. Conductor keeps working throughout; it reversed its shutdown on 12–13 Nov 2026, so never tell the user it is shutting down.

## Scripts (in `scripts/` next to this file)

- `import-to-capy.mjs`: scan, pick, select, export (workspaces and chats).
- `conductor-to-capy.mjs [repo] [--from-app] [--write] [--json]`: setup conversion. Without `--write` it only prints.
- `conductor-workspaces.mjs [repo] [--json]`: git-level view of Conductor worktrees (commits ahead, uncommitted files, whether pushed).

If you can't run them, follow `REFERENCE.md` in this folder by hand.

## Rules (in addition to the `import` skill's)

- Never delete or edit Conductor files (`conductor.json`, `.conductor/`, `.worktreeinclude`).
- Conductor's database is read only through a temporary copy that the scripts make and delete.
- Never push, commit in a Conductor worktree, or archive anything without asking. Uncommitted work belongs to the user.

## Setup conversion

1. **Find the config:** `.conductor/settings.toml` (+ `settings.local.toml`, which wins), else `conductor.json`. Current Conductor versions keep settings inside the app: on the user's Mac, run the converter with `--from-app` even when a file exists (the app may be newer). In a cloud thread there is no app database: ask the user to paste their setup script and actions, and convert them by `REFERENCE.md`.
2. **Show the plan:** the proposed `.capy/setup.json`, the `.capy/conductor-env.sh` shim if scripts use `CONDUCTOR_*`, and each TODO/SKIP line in one plain sentence. The three ideas: `scripts.initialize` = Conductor's setup script; `commands` = the Run button; `startup` = things that run on every boot. Variable values live in Capy's project settings, never in the file.
3. **After the user's yes:** a branch (`capy/import-from-conductor`), `--write`, offer to move Conductor's custom prompts into `AGENTS.md` (review rules under `## Reviews`) or a repository skill (ask first), list variable names for the user to re-enter (Capy's "Import .env" works), run the `initialize` script once as a check, then commit and open a PR titled "Import Conductor setup into Capy".

## Workspaces and chats

- A Conductor **project** is a repository; a **thread** in the menu is a workspace (its branch plus all its chats). Archived workspaces only with "including archived".
- **Unfinished** = not archived and not marked done/merged. **Open branches/PRs** = has a non-default branch and isn't archived.
- Before creating Capy threads for workspaces with work that isn't on GitHub (`conductor-workspaces.mjs` shows `needsPush`), say a cloud thread can't see it and offer to commit and push, only on a yes.
- Chat handoffs come from Conductor's `session_messages`. Each workspace's latest `claude_session_id` is checked against `~/.claude/projects/`; if the Claude Code session file is there, mention that Capy's desktop app can import Claude Code histories natively.

## End

Remind the user that Conductor still works as before; they can keep both, and removing Conductor's files later is their call.
