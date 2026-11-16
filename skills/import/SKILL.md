---
name: import
description: Use when the user wants to import, move, migrate, bring over or continue work from Conductor or T3 Code in Capy - "import", "import from conductor", "import from t3 code", "import my t3 threads", "move my conductor workspaces to capy", "bring my threads over", "continue my conductor chat here", "switch from T3 Code". Brings the picked Conductor workspaces and T3 Code threads into the right Capy project as real threads with their whole conversation, through Capy's own Claude Code / Codex session import; an API fallback and handoff summaries cover the rest. Asks with multiple-choice question cards (source, project, which threads, confirm). Complete on its own - it needs no MCP tools, no plugin tools, no computer use, no catalog search and no settings changes. Run it in a thread on the user's own computer (This Mac), where the data lives. Read-only on Conductor and T3 Code; secrets are redacted.
---

# Import from Conductor or T3 Code

You bring the user's Conductor workspaces or T3 Code threads into Capy as **real threads with their full conversation, in the right project**. Feel native: ask with question cards, one at a time, and keep every message short.

## Never

- Never look for MCP tools, plugin tools, integrations or the catalog (`mcp_find`, Explore). This skill is complete with its script.
- Never ask for computer use or desktop controls, and never send the user to Settings to refresh, enable or fix anything. The only settings page you may point to is **Import**, in the last step.
- Never read chat text without a yes, never print chat text, never write a key or secret to a file or the chat.
- Never use the Home project unless the user picks it.

## The script

```bash
S="<this skill's folder>/scripts/import-to-capy.mjs"     # Node 18+ and sqlite3, both on every Mac
[ -f "$S" ] && run="node $S" || run="npx -y -p github:HulkInTherapy/import-to-capy import-to-capy"
$run detect --json
```

If `detect` finds nothing, you are not on the user's computer: say "Your Conductor and T3 Code data is on your Mac. Start a new thread on **This Mac** and type `$import`." and stop.

## Ask (question cards, one per turn)

Use your built-in multiple-choice question tool (`clarify_questions`, the card that says "Waiting on you to choose"). One question per card, the options exactly as the script gives them, the recommended one first. Don't ask what the user already said ("import from conductor" means the source is answered).

1. **Source**, only if `detect` found both: "Import from which app?" → `Conductor`, `T3 Code`.
2. **Project**: run `$run questions --source <conductor|t3code>` and ask its `project.question` with its `project.options` (the most recent projects with thread counts and last-used dates, then "All projects"). Map the answer to `project.values`.
3. **Threads**: ask `threads.question` with `threads.options`: Latest 3 threads (recommended), Last 7 days, Last used project, Everything, Let me pick threads. For "Let me pick", run `$run questions --source X --project <name>` and ask its `pick` card (multiple choice; values are thread ids).
4. **Confirm**: `$run select --source X "<phrase>" --json` where the phrase is `project <name> latest 3 threads`, `project <name> last 7 days`, `last used`, `everything`, or `<name> everything` ("All projects" drops the `project` part). Show its `preview` (one screen), then ask: "Bring these N threads into Capy with their full history?" → `Yes, import them`, `Change the selection`.

## Import: best path first

**1. Capy's own import (real threads, full history).** Conductor and T3 Code run Claude Code and Codex, so each workspace or thread has a session file Capy's desktop app can import, into the project for its repository.

```bash
$run native --source X --threads <ids from select> --open
```

It opens Capy's Import page (`capy://app/settings/import`) and prints the exact clicks: which app (Claude Code / Codex), which repository group, which sessions to tick (title and date as Capy shows them, with the workspace or thread they belong to), and which project each goes to. If it says to create a project first, that comes first. Give the user those steps as they are, then ask with a card: "Done importing?" → `Done`, `Something looks wrong`. This is the only clicking the user does.

**2. API fallback, only for threads `native` lists under "No session file".** Ask one card: "N threads have no session file. Bring them as new threads with the full transcript attached (needs a Capy API key), or as short summaries?" → `With full transcript`, `Summaries only`, `Skip them`.
- With full transcript: `$run continue --source X --threads <those ids> --consent`. It finds the Capy project for the workspace's GitHub repository, starts the thread on this computer in the original worktree, posts a redacted handoff, and attaches the redacted transcript. If it prints how to save a key (Keychain), relay those two lines and wait; never ask the user to paste a key into the chat. If it says no project uses the repository, relay its one-line click path and stop.
- Summaries only (last resort, say it is a summary, not the conversation): `$run export --source X --threads <ids> --consent` and give each "Start a summary thread" link.

**3. Setup scripts (optional, once per project):** offer it after the threads are in. Conductor: `node <folder>/scripts/conductor-to-capy.mjs <repo> --from-app` prints a `.capy/setup.json`; T3 Code: `$run setup --source t3code --project <name>`. Commit it on a branch and open a PR only after a yes.

## Finish

One short message: what landed where (project, thread titles), how many secrets were redacted, anything that could not come over and why. Conductor and T3 Code are untouched and keep working.

## Details

- Selection words the script understands: everything, latest N threads, last N days, today, last used, only unfinished, with open branches/PRs, including archived, numbers, names, ranges.
- Reads: Conductor `~/Library/Application Support/com.conductor.app/conductor.db` through a temporary copy; T3 Code `~/.t3/userdata/statev2.sqlite` opened `immutable=1`, never copied (it can be gigabytes), so the last minutes may be missing; session files in `~/.claude/projects` and `~/.codex/sessions` (headers only).
- T3 Code subagent runs belong to their parent thread and come along with it.
