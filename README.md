# Import to Capy

A Capy plugin that brings your work from **Conductor** or **T3 Code** into Capy: projects and their setup scripts, plus the threads you pick, each continued in Capy with a short handoff of its chat (secrets redacted). It only reads the source app; nothing there changes, so you can keep using both.

*Made by Meghavi, a Capy user who has applied to Capy's growth team. Not affiliated with Capy, Conductor or T3 Code.*

## Install

**In Capy:** open this link and confirm.

```text
https://capy.ai/settings/mcp?github=https://github.com/HulkInTherapy/import-to-capy
```

Then, in a thread **on your Mac** (Capy desktop app → **Run on → This Mac**, since that's where the data is), say **"import"**.

**In Claude Code or Codex:** copy the three folders in `skills/` into `~/.claude/skills/` (or your agent's skills folder) and say "import". To get the native form and picker as MCP tools too, add the server, e.g. `claude mcp add import-to-capy -- node /path/to/import-to-capy/lib/mcp-server.mjs` (check `claude mcp add --help` for your version).

**From a terminal** (Node 18+, the `sqlite3` command, nothing to install):

```bash
npx -y -p github:HulkInTherapy/import-to-capy import-to-capy scan --source t3code
npx -y -p github:HulkInTherapy/import-to-capy import-to-capy pick --source conductor
npx -y -p github:HulkInTherapy/import-to-capy conductor-to-capy . --from-app
```

## What it feels like

*An example; the names and numbers are made up.*

> **You:** import
>
> **Capy:** I found Conductor and T3 Code on this Mac. Import from Conductor or T3 Code?
>
> **You:** t3
>
> **Capy:** I opened a picker in your browser. *(Or, where a page can't open:)*
> 1. api: 12 threads, last used 2026-11-16
> 2. web: 5 threads, last used 2026-11-13
> 3. docs: 2 threads, last used 2026-10-28
>
> Which ones? Say a number or name, everything, latest 3 threads, last 7 days, last used, only unfinished, or with open PRs. Or just say go for your most recent project's latest 3 threads.
>
> **You:** go
>
> **Capy:** Bring the chat history too? I'll write a short handoff per thread, with secrets redacted. Nothing is committed to main.
>
> **You:** yes
>
> **Capy:** Will create in Capy (your most recent project "api", its latest 3 threads):
> - Project "api" (/src/api): Install → scripts.initialize; action "Dev" → commands: "dev"
>     - "Fix login bug" on me/login, PR #12 open, 4 messages, last 2026-11-16
>     - "Add rate limits" on me/rate, 18 messages, last 2026-11-14
>     - "Refactor db layer" on me/db, 31 messages, last 2026-11-12
>
> 1 project(s), 3 thread(s). Import this?
>
> **You:** yes
>
> **Capy:** Done. Setup PR: … · 3 threads, each with a "Continue in Capy" link · 5 secrets redacted · Left for you: merge the PR, re-enter your environment values with "Import .env".

Other answers it understands: `everything`, `just api`, `api and docs`, `2`, `1 and 3`, `2-4`, `the latest 3 threads`, `latest 2 threads from web`, `threads from the last 7 days`, `today`, `last used`, `threads with open branches/PRs`, `only unfinished`, `everything including archived`. Anything unclear gets one follow-up question.

## How you pick: three layers, best first

The agent says which one it used.

1. **A native form** (MCP elicitation). The plugin's MCP tool `choose_import` asks the client to show a form: source, project, which threads, N, include chats. Only when the client advertises elicitation support; Capy doesn't document it, so this may not appear in Capy yet.
2. **A local picker page.** A one-time page on `127.0.0.1` (random port, one-time token, closes after you press Import): project cards with thread counts and last-used dates, quick chips (Latest 3, Last 7 days, Last used, Unfinished, Open branches/PRs, Everything), checkboxes, a live count. It shows titles and dates only, never chat text, and never listens beyond your machine.
3. **The typed menu** above, for cloud threads, Slack, or when no browser can open.

In Capy today, threads on your own computer get a plugin's *remote* MCP servers only, and this server is local (stdio). So on your Mac the skill opens the picker page by running the script directly, which is layer 2 without MCP. Layer 1 works in clients that run local MCP servers and support elicitation.

## What gets imported

| | Conductor | T3 Code |
|---|---|---|
| Projects | repositories | projects (`workspace_root`) |
| Setup | setup/run/archive scripts → `.capy/setup.json` (PR) | project scripts → `.capy/setup.json` (PR) |
| Threads | workspaces (branch + its chats) | threads |
| Chat history (after you say yes) | `session_messages` → handoff per workspace | messages → handoff per thread |
| Native history | Claude Code session file, if on disk | Claude Code / Codex session file, if on disk |
| Branches, PRs | branch, PR title | branch, PR number, state, link |

Each handoff has: title, goal, key decisions, files touched, open TODOs, last state, and the last 3 exchanges verbatim (trimmed). Optional full transcript (`--transcripts`). Both are redacted (API keys, tokens, passwords, `.env` values, private keys, credentials in URLs), with a count. They go to `.capy-import/<time>/`, which git ignores; transcripts are committed only on a separate branch if you ask.

Capy's desktop app can also import Claude Code and Codex histories as threads when you first set it up. Where the original session file is on your Mac, the import tells you, and that native path keeps more detail than a handoff.

## What it reads, and what it never does

- **T3 Code:** `~/.t3/userdata/statev2.sqlite`, opened with `immutable=1`: never copied (it can be gigabytes), never written, never locked. Immutable reads skip the write-ahead log, so the last few minutes of activity may be missing.
- **Conductor:** `~/Library/Application Support/com.conductor.app/conductor.db`, copied with its `-wal`/`-shm` to a temp folder, read, deleted.
- Never reads environment variable values; never edits or deletes anything in Conductor or T3 Code; never pushes or commits without asking; reads chat text only after you say yes.

## What it can't import

| Thing | Why |
|---|---|
| Environment values and secrets | Never read, by design. Re-enter them in Capy (its "Import .env" button works). |
| Attachments in chats (images, files), T3 plans and tool-by-tool output | Only message text is carried over. |
| Conductor Cloud organization settings | Stored on Conductor's servers; copy your Cloud Computer install script by hand. |
| Uncommitted work in a worktree | Cloud machines only see GitHub; commit and push first (the skill asks). |
| Archive scripts, Spotlight testing, run modes | No Capy equivalent. |
| T3 Code on a server | Supported by running the scripts on that server (pair it with `capy dock`); documented, not yet tested. |
| GitLab / Bitbucket | Capy's docs cover GitHub only. |

## Develop

```bash
npm test           # 50 tests: real public Conductor configs, synthetic Conductor and T3 Code databases
                   # built from the apps' real schemas, every selection phrase, redaction, the picker page,
                   # the MCP server's three layers, plugin validation
npm run validate   # plugin.json and mcp.json against the Agent Plugins 1.0.0 schemas, plus Capy's plugin rules
npm run sync       # copy lib/ into each skill's scripts/ after editing
```

`lib/` is the source of truth. Each skill carries a copy in `scripts/` so it works on its own; a test fails if a copy drifts.

## For Capy's team

1. **"Import from Conductor / T3 Code" as an onboarding step.** Detect `conductor.json`, `.conductor/`, `~/conductor/workspaces` or `~/.t3/userdata` on first run of the desktop app, and offer the same menu: projects with counts and dates, "latest 3 threads" as the default.
2. **Prefill the Dev environment** from the converted setup through the agent's environment tools; keep the PR path for teams that review setup in git.
3. **Native choice cards for plugins.** Capy's docs show no way for a plugin to present options (no plan mode, no question tool, no MCP elicitation). A native choice-card or elicitation surface would make every plugin's setup flow better, not just this one; until then this plugin falls back to a localhost page and a typed menu.
4. **Measure** imports as a funnel: detected → picked → imported → first green thread → active in week 2.

MIT-licensed; take whatever helps.
