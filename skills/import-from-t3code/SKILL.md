---
name: import-from-t3code
description: Use when the user says "import from t3 code", "import from t3", "import my T3 threads", "move from T3 Code to Capy", "bring my T3 Code chats over", or "continue my T3 thread in Capy". Brings the picked T3 Code threads into the Capy project for their repository as real threads with the whole conversation (T3 Code runs Claude Code and Codex, whose sessions Capy's own import reads), with question cards for project and which threads (latest 3, last 7 days, last used, everything, pick). Also converts T3 project scripts to .capy/setup.json on request. Needs no MCP tools, no computer use, no settings changes. Run in a thread on This Mac. Read-only on T3 Code; never copies its database.
---

# Import from T3 Code

Run the **`import` skill's flow** with the source already answered: T3 Code. Its instructions are in `../import/SKILL.md` (same plugin or Drive folder); if that file isn't there, use `npx -y -p github:HulkInTherapy/import-to-capy import-to-capy` as the script and follow these steps:

1. `detect --json` (must list `t3code`; else ask the user to start a thread on **This Mac** and type `$import-from-t3code`).
2. Question cards, one at a time, with your multiple-choice question tool (`clarify_questions`): `questions --source t3code` gives the project card and the threads card. Never search for MCP tools, never ask for computer use, never send the user to Settings except the Import page in step 4.
3. `select --source t3code "<phrase>" --json`, show the preview, confirm with a card.
4. `native --source t3code --threads <ids> --open`: it opens Capy's Import page and prints exactly which Claude Code or Codex sessions to tick and which project they go to. Relay those steps.
5. Threads it lists under "No session file": offer `continue --source t3code --threads <ids> --consent` (new thread in the right project on this Mac, full redacted transcript attached) or, as a last resort, `export ... --consent` (summary only).

T3 Code specifics:
- Reads `~/.t3/userdata/statev2.sqlite` with `immutable=1` only: never copy, lock or write it (it can be gigabytes). Immutable reads skip the write-ahead log, so the last few minutes may be missing; say so if the user looks for something they just did.
- A thread's session: the provider thread's native id → `~/.claude/projects/**/<id>.jsonl` (Claude) or `~/.codex/sessions/**/rollout-*<id>.jsonl` (Codex). Subagent runs belong to their parent thread.
- T3 worktrees live under `~/.t3/worktrees/`; leave them as they are.
- Project scripts on request: `setup --source t3code --project <name>` prints `.capy/setup.json` (scripts that run on worktree creation → `scripts.initialize`, the rest → `commands`). Commit on a branch with a PR after a yes.
- T3 Code keeps working; the user can use both.
