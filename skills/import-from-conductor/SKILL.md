---
name: import-from-conductor
description: Use when the user says "import from conductor", "import my conductor workspaces", "move from Conductor to Capy", "bring my Conductor chats/threads over", "continue my Conductor workspace in Capy", or a repository has conductor.json or .conductor/. Brings the picked Conductor workspaces into the Capy project for their repository as real threads with the whole conversation (Conductor's chats are Claude Code sessions, which Capy's own import reads), with question cards for project and which workspaces (latest 3, last 7 days, last used, everything, pick). Also converts Conductor setup/run scripts to .capy/setup.json on request. Needs no MCP tools, no computer use, no settings changes. Run in a thread on This Mac. Read-only on Conductor.
---

# Import from Conductor

Run the **`import` skill's flow** with the source already answered: Conductor. Its instructions are in `../import/SKILL.md` (same plugin or Drive folder); if that file isn't there, use `npx -y -p github:HulkInTherapy/import-to-capy import-to-capy` as the script and follow these steps:

1. `detect --json` (must list `conductor`; else ask the user to start a thread on **This Mac** and type `$import-from-conductor`).
2. Question cards, one at a time, with your multiple-choice question tool (`clarify_questions`): `questions --source conductor` gives the project card and the threads card. Never search for MCP tools, never ask for computer use, never send the user to Settings except the Import page in step 4.
3. `select --source conductor "<phrase>" --json`, show the preview, confirm with a card.
4. `native --source conductor --threads <ids> --open`: it opens Capy's Import page and prints exactly which Claude Code sessions to tick and which project they go to. Relay those steps.
5. Workspaces it lists under "No session file": offer `continue --source conductor --threads <ids> --consent` (new thread in the right project on this Mac, full redacted transcript attached) or, as a last resort, `export ... --consent` (summary only).

Conductor specifics:
- A Conductor **project** is a repository; a **thread** is a workspace (a git worktree under `~/conductor/workspaces/<repo>/<name>`, its branch and all its chats). Archived workspaces only with "including archived".
- Uncommitted work stays in the worktree; never commit, push, archive or delete anything in Conductor without a yes.
- Setup conversion on request: `node ../import/scripts/conductor-to-capy.mjs <repo> --from-app` prints `.capy/setup.json` (`scripts.initialize` = setup script, `commands` = Run button). Rules for doing it by hand are in `REFERENCE.md` here. Variable values are never read; the user re-enters them (Capy's "Import .env" works).
- Conductor keeps working; the user can use both.
