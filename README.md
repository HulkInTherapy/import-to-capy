# Import to Capy

Bring your **Conductor** workspaces and **T3 Code** threads into Capy as **real threads with their whole conversation**, in the Capy project for their repository, ready to continue. Type `$import` in a thread on your Mac. It only reads Conductor and T3 Code; both keep working.

*Made by Meghavi, a Capy user. Not affiliated with Capy, Conductor or T3 Code.*

## How it works

Capy's desktop app already imports local **Claude Code** and **Codex** sessions as real threads (Settings → Import). Conductor and T3 Code run Claude Code and Codex underneath, so every Conductor workspace and T3 Code thread already has a session file on your Mac. Capy's import lists those files by folder and first prompt, though, not by your workspace names, so finding the right ones is guesswork.

This plugin does the part Capy doesn't: it asks which project and which threads you want (by their real names), finds the exact session file behind each one, opens Capy's Import page and tells you exactly which sessions to tick and which project they go to. Capy does the import itself, so you get the real history, not a summary.

Threads with no session file (rare for T3 Code; more common for old Conductor workspaces) can come over through Capy's API instead: a new thread in the right project, on your Mac in the original worktree, with a redacted handoff and the full redacted transcript attached. A short handoff summary is the last resort, and it's labelled as one.

## What it feels like

*The project and thread names are made up.*

> **You:** `$import` from conductor
>
> **Capy:** *(question card)* Which Conductor project?
> ○ api · 4 threads · last used 16 Nov  ○ web · 2 threads · last used 13 Nov  ○ All projects
>
> **You:** api
>
> **Capy:** *(question card)* Which threads?
> ○ Latest 3 threads (recommended)  ○ Last 7 days  ○ Last used project  ○ Everything  ○ Let me pick threads
>
> **You:** Latest 3 threads
>
> **Capy:** api: "Fix login bug" (me/login, PR #12), "Add rate limits" (me/rate), "Refactor db layer" (me/db). *(card)* Bring these 3 into Capy with their full history?
>
> **You:** Yes, import them
>
> **Capy:** I opened Capy's Import page. Click **Claude Code**, open **acme/api** and tick "Login fails for SSO users", "Add a rate limiter to…" and "Split the db module…" (dated 16, 14 and 12 Nov). **Next** → acme/api goes to **api** → **Import**.
>
> **You:** done
>
> **Capy:** All 3 are in **api** with their conversations, on their branches. Conductor is untouched.

## Install

**1. Add the plugin** (open the link, confirm):

```text
https://capy.ai/settings/mcp?github=https://github.com/HulkInTherapy/import-to-capy
```

**2. Make it reach threads on your Mac.** Capy's docs say plugin skills run in threads on cloud machines; a thread on your own computer gets built-in, repository and Drive skills. Your Conductor and T3 Code data is on your Mac, so also add the skills to your **personal Drive** once. In any thread, say:

> Install the skills from github.com/HulkInTherapy/import-to-capy/tree/main/skills into my personal drive.

(or Drive → Personal → New skill, one per folder in `skills/`).

**3. Use it:** new thread → **Machine: This Mac** → type `$import` (or `$import-from-conductor`, `$import-from-t3code`), or just say "import from conductor".

**Claude Code / Codex:** copy the folders in `skills/` into `~/.claude/skills/` and say "import".

**Terminal** (Node 18+ and `sqlite3`, nothing to install):

```bash
npx -y -p github:HulkInTherapy/import-to-capy import-to-capy native --source conductor --answer "latest 3 threads" --open
npx -y -p github:HulkInTherapy/import-to-capy import-to-capy native --source t3code --answer "last 7 days" --open
```

## Commands

| Command | What it does |
|---|---|
| `detect` | Which of Conductor / T3 Code is on this computer |
| `questions --source X [--project P]` | The question cards: projects (recent first, with counts and dates), thread choices, a pick list |
| `select --source X "<words>"` | Resolves "latest 3 threads", "project api last 7 days", "everything"… and prints a one-screen preview |
| `native --source X --threads … [--open]` | Finds each thread's Claude Code / Codex session file and prints the exact clicks for Capy's Import; `--open` opens `capy://app/settings/import` |
| `continue --source X --threads … --consent` | API fallback for threads without a session file (key from `CAPY_API_KEY` or the Keychain item `import-to-capy`) |
| `export --source X --threads … --consent` | Last resort: redacted handoff summaries plus a "start a summary thread" link |
| `setup --source t3code --project P` / `conductor-to-capy <repo> --from-app` | Setup scripts → `.capy/setup.json` |

The API key for `continue` never goes in a file or the chat. Save it once in your Keychain:

```bash
security add-generic-password -U -s import-to-capy -a capy -w     # paste the key from Capy → Settings → API
```

## Where it lands

- **Project:** Capy's import puts each session in the project whose repository matches the worktree's GitHub remote. If no project uses that repository yet, the steps tell you to create it first (Settings → Projects & setup), so all its threads land together. Home is never chosen for you.
- **Branch and history:** the whole conversation, tool calls included, as Capy's import brings it; the branch the workspace is on. Your worktree and its uncommitted files stay where they are.
- **Fallback threads** start on your Mac in the original worktree (`device` target), so uncommitted work is right there.

## What it reads, and what it never does

- **Conductor:** `~/Library/Application Support/com.conductor.app/conductor.db`, through a temporary copy that is deleted.
- **T3 Code:** `~/.t3/userdata/statev2.sqlite`, opened `immutable=1`: never copied (it can be gigabytes), written or locked. Immutable reads skip the write-ahead log, so the last few minutes may be missing. Subagent runs belong to their parent thread.
- **Session files:** `~/.claude/projects/**.jsonl` and `~/.codex/sessions/**` headers only: the id, folder, branch, dates and the first prompt line Capy itself shows as the title.
- Chat text is read only for the fallback, only after you say yes, and is redacted (API keys, tokens, passwords, `.env` values, private keys, credentials in URLs) with a count.
- Never edits Conductor or T3 Code, never commits or pushes without asking, never reads environment variable values.

## What can't come over

| Thing | Why |
|---|---|
| Environment values and secrets | Never read. Re-enter them in Capy ("Import .env" works). |
| Workspaces whose chats left no session file | Fallback: transcript attached, or a summary. |
| Conductor Cloud organization settings | Stored on Conductor's servers. |
| Archive scripts, Spotlight testing, run modes | No Capy equivalent. |

## Develop

```bash
npm test           # 63 tests: synthetic Conductor and T3 Code databases from the real schemas, Claude Code and Codex
                   # session files shaped like real ones, Capy's title rules, project matching, the API fallback
                   # against a fake api.capy.ai, every selection phrase, redaction, plugin validation
npm run validate   # plugin.json and mcp.json against Agent Plugins 1.0.0, plus Capy's plugin rules
npm run sync       # copy lib/ into skills/import/scripts after editing
```

The plugin has no MCP server on purpose: a local (stdio) server never reaches threads on your Mac, and it showed as "Not checked" on the plugin page.

## For Capy's team

1. **Let Import show where a session came from.** Conductor and T3 Code sessions are ordinary Claude Code / Codex sessions under `~/conductor/workspaces/…` and `~/.t3/worktrees/…`; naming them "Conductor: <workspace>" / "T3 Code: <thread>" would make Import the migration path for both.
2. **Plugin skills in threads on your own computer.** Today they reach cloud machines only, so a plugin that works on local data needs a Drive copy.
3. **A deep link with a preselection,** e.g. `capy://app/settings/import?source=claude-code&sessions=…`, so a skill could hand over exactly the sessions it found.

MIT-licensed; take whatever helps.
