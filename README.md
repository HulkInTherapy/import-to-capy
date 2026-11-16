# Import to Capy

Bring your **Conductor** workspaces and **T3 Code** threads into Capy as threads in the right project, with their titles, branches and whole conversation, ready to continue. Say "import from conductor" in a thread on your Mac. It only reads Conductor and T3 Code; both keep working.

*Made by Meghavi, a Capy user. Not affiliated with Capy, Conductor or T3 Code.*

## How it works

Say "import from conductor" (or "import from t3 code") in a Capy thread on your Mac. Capy's agent gets this plugin's playbook from its small remote server (remote servers reach threads on your own computer; plugin skills don't), runs the importer on your Mac with `npx` (nothing to install), and asks at most two things: what to bring, and a final yes. Then it creates each thread itself with Capy's own `thread.create` tool:

- **in the right project:** the Capy project whose repository matches the workspace's git remote (if none does, it asks once and remembers);
- **with the original title,** on your Mac, on the same branch;
- **with the conversation:** the importer writes a redacted handoff and the full redacted transcript to `~/.capy-import/`, and the new thread's first message points at them and at the original worktree, where your uncommitted files stay.

No API key, no clicks after the yes. If you also want the original message-by-message history, Capy's own Import (Settings → Import → Claude Code / Codex) can bring the session files too; the importer tells you exactly which sessions to tick (3 clicks, optional).

## What it feels like

*The project and thread names are made up.*

> **You:** import api from conductor
>
> **Capy:** api: "Fix login bug" (me/login), "Add rate limits" (me/rate), "Refactor db layer" (me/db). *(card)* Import these 3 threads into Capy?
>
> **You:** Yes, import them
>
> **Capy:** Done. All 3 are in **api** on this Mac, on their branches, each starting from its handoff and full transcript (2 secrets redacted). Conductor is untouched. Want the original message-by-message history too? That's 3 clicks in Capy's Import.

## Install

**1. Add the plugin** (open the link, confirm):

```text
https://capy.ai/settings/mcp?github=https://github.com/HulkInTherapy/import-to-capy
```

**2. Use it:** new thread → **Machine: This Mac** → "import from conductor" or "import from t3 code" (or `$import` in a cloud thread, where the skills load).

That's all. The plugin's server, `https://import-to-capy-mcp.vercel.app/mcp`, needs no sign-in and stores nothing; it only hands the agent the steps, and everything runs on your Mac.

**Claude Code / Codex:** copy the folders in `skills/` into `~/.claude/skills/` and say "import".

**Terminal** (Node 18+ and `sqlite3`, nothing to install):

```bash
npx -y -p github:HulkInTherapy/import-to-capy import-to-capy select --source conductor "latest 3 threads"
npx -y -p github:HulkInTherapy/import-to-capy import-to-capy native --source t3code --answer "last 7 days" --open
```

### Troubleshooting

- **The agent doesn't use the plugin:** open the plugin page in Settings → MCP & plugins and click **Sync** (GitHub plugins update only on Sync), then check that its server shows **Connected**.
- **Still nothing on a thread on your Mac:** as a fallback you can copy the skills into your personal Drive once ("Install the skills from github.com/HulkInTherapy/import-to-capy/tree/main/skills into my personal drive").

## Commands

| Command | What it does |
|---|---|
| `ready` | Which of Conductor / T3 Code is on this computer, and this computer's name |
| `questions --source X [--project P]` | The question cards: a single "what" card (recent projects, last 7 days, pick), a pick list |
| `select --source X "<words>"` | Resolves "c2c-demo", "latest 3 threads", "project api last 7 days", "everything"… and prints a one-screen preview |
| `prepare --source X --threads … --consent` | Per thread: repo, branch, worktree, uncommitted files, a continuation prompt; writes the redacted handoff and transcript to `~/.capy-import/` |
| `remember --key <owner/repo> --project <name>` | Remembers where a repository with no Capy project goes |
| `native --source X --threads … [--open]` | Optional: the exact clicks for Capy's own Import of the original sessions |
| `export --source X --threads … --consent` | Last resort: redacted handoff summaries plus a "start a summary thread" link |
| `setup --source t3code --project P` / `conductor-to-capy <repo> --from-app` | Setup scripts → `.capy/setup.json` |

**Advanced (automation only, off by default):** `login`, `plan` and `import` create threads through Capy's public API with your own API key (kept in the macOS Keychain, item `import-to-capy`, pasted once into a local page). The plugin's normal flow never uses them.

## Where it lands

- **Project:** the Capy project whose repository matches the workspace's GitHub remote. If none does, one question: create it (New project → Folder on this Mac or the repository) or pick an existing one; the choice is remembered in `~/.config/import-to-capy/projects.json`. Home is never chosen for you.
- **Branch and folder:** a new Capy worktree on your Mac from the same branch (or the project's folder). The original Conductor / T3 worktree and its uncommitted files stay where they are; the thread is told where.
- **History:** a redacted handoff (goal, last state, files touched, to-dos) and the full redacted transcript, which the thread reads from `~/.capy-import/`.

## What it reads, and what it never does

- **Conductor:** `~/Library/Application Support/com.conductor.app/conductor.db`, through a temporary copy that is deleted.
- **T3 Code:** `~/.t3/userdata/statev2.sqlite`, opened `immutable=1`: never copied (it can be gigabytes), written or locked. Immutable reads skip the write-ahead log, so the last few minutes may be missing. Subagent runs belong to their parent thread.
- **Session files:** `~/.claude/projects/**.jsonl` and `~/.codex/sessions/**` headers only: the id, folder, branch, dates and the first prompt line Capy itself shows as the title.
- Chat text is read only after you say yes, and is redacted (API keys, tokens, passwords, `.env` values, private keys, credentials in URLs) with a count.
- Never edits Conductor or T3 Code, never commits or pushes without asking, never reads environment variable values.

## What can't come over

| Thing | Why |
|---|---|
| Environment values and secrets | Never read. Re-enter them in Capy ("Import .env" works). |
| The message-by-message history inside the new thread | The thread reads the full transcript; Capy's own Import can add the original session as a second thread. |
| Conductor Cloud organization settings | Stored on Conductor's servers. |
| Archive scripts, Spotlight testing, run modes | No Capy equivalent. |

## Develop

```bash
npm test           # 77 tests: synthetic Conductor and T3 Code databases from the real schemas, session files, Capy's title
                   # rules, project matching, prepare/remember, redaction, the remote MCP server (handshake, tools,
                   # errors, no state), plugin validation, and that every playbook copy matches playbook/PLAYBOOK.md
npm run validate   # plugin.json and mcp.json against Agent Plugins 1.0.0, plus Capy's plugin rules
npm run sync       # after editing lib/ or playbook/PLAYBOOK.md: copies lib/ into skills/import/scripts and
                   # rebuilds the three SKILL.md files and server/api/_playbook.js from the one playbook
```

The playbook lives in one file, `playbook/PLAYBOOK.md`; the skills (for cloud threads) and the remote server (for threads on your Mac) are built from it. The server is `server/`, a stateless Vercel function (`cd server && vercel deploy --prod`), Streamable HTTP, no sign-in, no storage, no logging.

A note for Capy's team is in [FOR-CAPY.md](FOR-CAPY.md).

MIT-licensed; take whatever helps.
