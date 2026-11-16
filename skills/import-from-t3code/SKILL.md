---
name: import-from-t3code
description: Import projects and threads from T3 Code (the desktop app that runs Claude Code and Codex agents) into Capy. Use when the user says "import from T3 Code", "bring my T3 threads", "move from T3", or picks T3 Code in the import flow. Lists T3 projects with thread counts and last-used dates, lets the user pick in plain words ("latest 3 threads", "just api", "last 7 days", "unfinished", "everything"), converts project scripts to Capy setup, and turns each picked thread into a Capy thread with a redacted handoff of its chat. Read-only on T3 Code; never copies or locks its database.
---

# Import from T3 Code

Follow the flow in the `import` skill (detect → scan → pick → chats once → preview → one confirmation → import → summary), with `--source t3code`. This file adds what is specific to T3 Code.

## Scripts

`scripts/import-to-capy.mjs` in this skill's folder (same commands as in the `import` skill). Run it on the user's Mac.

## Where T3 Code keeps things (read-only)

| Data | Where | How it's read |
|---|---|---|
| Projects | `~/.t3/userdata/statev2.sqlite`, table `projection_projects` (`title`, `workspace_root`, `scripts_json`) | `file:...?immutable=1`, never copied (it can be gigabytes and is live) |
| Threads | `orchestration_v2_projection_threads` (`title`, `created_at`, `updated_at`, `archived_at`, `deleted_at`; `payload_json` has `branch`, `worktreePath`, `settledAt`, `pullRequests`) | same |
| Messages | `orchestration_v2_projection_messages` (`role`, `payload_json.text`) | only after the user's consent |
| Agent sessions | `orchestration_v2_projection_provider_threads` (`provider`, `payload_json.nativeThreadRef.nativeId`) → `~/.claude/projects/*/<id>.jsonl` or `~/.codex/sessions/**` | existence check only |
| Worktrees | `~/.t3/worktrees/` | not touched |

Immutable reads skip T3 Code's write-ahead log, so activity from the last few minutes may be missing. Say so if the user is looking for something they did just now.

## Meanings

- **Unfinished** = not settled and not archived. **Open branches/PRs** = has a non-default branch with no merged/closed PR, or an open PR. **Last used** = the project with the most recent thread activity. Deleted threads are never shown; archived ones only with "including archived".
- **Project scripts** (`scripts_json`: `name`, `command`, `runOnWorktreeCreate`) → Capy: scripts that run on worktree creation become `scripts.initialize` (their install command also becomes `scripts.refresh`); the rest become `commands`. `setup --source t3code --project <name>` prints the `.capy/setup.json`. Commit it on a branch and open a PR after the user confirms.

## Can't be imported

Message attachments (images, files), plans and turn-by-turn tool output beyond what's in the message text, T3 Code's own settings, and anything on a T3 Code server you haven't run this on (see below).

## T3 Code on a server (linked environment)

The data then lives on that server, under the server user's `~/.t3/userdata/`. To import it: pair the server with Capy (`capy dock` on the server, then **Run on** that device), copy this skill's `scripts/` folder there, and run the same commands with `--home /home/<user>` if needed. Picking falls back to the typed menu there (no browser). [This path is documented, not yet tested.]
