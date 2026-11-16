---
name: import
description: Use when the user wants to import, move, migrate, bring over or continue work from Conductor or T3 Code in Capy - "import", "import from conductor", "import from t3 code", "import my t3 threads", "move my conductor workspaces to capy", "bring my threads over", "continue my conductor chat here", "switch from T3 Code". Creates the picked Conductor workspaces and T3 Code threads as new Capy threads with the agent's own thread.create tool: right project, original titles, on the user's Mac on the same branch, whole conversation handed over (redacted). No key, zero clicks after one confirm card; asks only what the user didn't say. Complete on its own - no computer use, no catalog search, no settings changes. Runs where the user's data is: their own computer (This Mac). Read-only on Conductor and T3 Code; secrets are redacted.
---

<!-- Generated from playbook/PLAYBOOK.md by `npm run sync`. Edit there, not here. -->

# Import from Conductor or T3 Code

You bring the user's Conductor workspaces or T3 Code threads into Capy **yourself**: each one becomes a new Capy thread in the right project, with its original title, on this Mac, starting from a short continuation note that points at its handoff and full conversation (redacted). You create them with your own built-in `thread.create` tool, so the user needs no key and, after one "yes", clicks nothing. Ask with question cards, as few as possible, and keep every message short.

## Never

- Never look for more MCP tools, plugin tools, integrations or the catalog (`mcp_find`, Explore). This playbook, the importer and your built-in tools are all you need.
- Never ask for computer use or desktop controls, and never send the user to Settings to refresh, enable or fix anything. The only places you may send them are **New project** (only if they choose to create a missing project) and **Import** (the optional extra at the end).
- Never create threads any other way than `thread.create` (no API keys, no curl, no files dropped into Capy's folders), and never read Capy's own app data or credentials (`~/.capy`, `~/Library/Application Support/Capy`).
- Never print chat text, never write a key or secret to a file or the chat.
- Never use the Home project unless the user picks it.
- Never edit, archive or delete anything in Conductor or T3 Code, and never commit or push without a yes.

## The importer

It runs on the user's computer, in your shell. It needs Node 18+ and `sqlite3` (both on every Mac) and nothing to install.

```bash
S="<this skill's folder>/scripts/import-to-capy.mjs"     # bundled with this skill; npx is the fallback
if [ -f "$S" ]; then run="node $S"; c2c="node ${S%/*}/conductor-to-capy.mjs"
else run="npx -y -p github:HulkInTherapy/import-to-capy import-to-capy"; c2c="npx -y -p github:HulkInTherapy/import-to-capy conductor-to-capy"; fi
$run ready --json
```

Below, `$run` means that command. If your shell forgets variables between commands, write the full command each time.

If `ready` finds no `sources`, or you have no shell on the user's computer, you are on a cloud machine: say "Your Conductor and T3 Code data is on your Mac. Start a new thread on **This Mac** and say *import from conductor* (or *import from t3 code*)." and stop. `computerName` is this Mac's name; you need it to pick the machine below.

## What to bring (ask only what the user hasn't said)

Use your built-in multiple-choice question tool (`clarify_questions`, the card that says "Waiting on you to choose"): one question per card, the options exactly as the importer gives them, the recommended one first.

- **The user already said what** ("import c2c-demo from conductor", "latest 3 from t3 code project api", "everything from last week"): run `$run select --source X "<their words>" --json`. If it resolves (no `needsClarification`), ask nothing more and go to the confirm.
- **Source**, only if `ready` found both and the user didn't say: "Import from which app?" → `Conductor`, `T3 Code`.
- **What**: run `$run questions --source X` and ask its `what` card (its options; map the answer to `what.values`). A value is a phrase for `$run select --source X "<phrase>" --json`. For `pick`, ask the `pickAny` card instead (multiple choice; its values are thread ids).

**Confirm** (always, and the last question unless a project is missing): show `select`'s `preview` in a few lines, then ask "Import these N threads into Capy?" → `Yes, import them`, `Change the selection`. This yes is also the consent to read the chats.

## Prepare (on this Mac)

```bash
$run prepare --source X --threads <ids from select> --consent --json
```

For each thread it gives `title`, `repo` (owner/name, lowercase), `branch`, `branchOnOrigin`, the original `worktree`, `uncommitted` files, `rememberedProject`, and a ready `prompt`. It also writes a redacted handoff and the full redacted transcript to `~/.capy-import/` (outside every repository); the prompt tells the new thread where they are, and the new thread runs on this same Mac, so it can read them.

## Create the threads (your built-in tools, through `execute`)

These were the tool shapes on 16 Nov 2026. Check them first with `describe("project.list")`, `describe("machine.list")` and `describe("thread.create")`, and follow `describe` where it differs.

1. **Projects and machine:** `tools.project.list({})` and `tools.machine.list({})`. For each thread, the project is the one whose repositories include its `repo` (compare case-insensitively), else its `rememberedProject`. Never Home unless the user picked it. The machine is the one named `computerName` (this Mac).
2. **A repository with no project:** no tool can create projects or link folders, so ask one card per repository: "No Capy project uses <repo> yet. Where should its N threads go?" → `Create a <name> project first`, then up to three existing projects, then `Home`. If they pick one, run `$run remember --key <the thread's key> --project "<name>"` so it never asks again. If they create one, say: "In Capy: **New project** → **Folder on this Mac** → choose <fromFolder> (or pick the <repo> repository) → Create. Then tell me." Ask "Created?" → `Done`, then list projects again.
3. **Create, all in one call:**

```js
return await tools.thread.create({ threads: [
  // one entry per prepared thread
  { project: "<project id or code>", title: "<title>", prompt: "<prompt>", machine: "<this Mac's machine id>",
    into: "new-worktree", repos: [{ repo: "<repo as the project lists it>", branch: "<branch>" }] },
] });
```

Use `into: "new-worktree"` with the thread's `repo` and `branch` when the project has that repository and the thread has a branch, so it starts on the same branch. Otherwise (no branch, a folder project, or a thread with no remote) use `into: "same-folder"` with no `repos`: it runs in the folder the project is linked to on this Mac. If an entry fails (for example a branch Capy can't check out), create that one again with `into: "same-folder"`; the prompt still points at the original worktree.

## Finish

One short message: each thread title, the project it is in and its link or code from `thread.create`'s result, how many secrets were redacted (`redacted`), anything that could not come over and why. Conductor and T3 Code are untouched and keep working.

Then offer, in one line each and only if they apply:
- "Want the original message-by-message history too? That's 3 clicks in Capy's Import." On yes: `$run native --source X --threads <ids> --open`; it opens Capy's Import page (`capy://app/settings/import`) and prints exactly what to tick and where it goes. Relay those steps. (It adds a second thread with the original history.)
- "Want the project's setup scripts as `.capy/setup.json`?" Conductor: `$c2c <repo folder> --from-app`. T3 Code: `$run setup --source t3code --project <name>`. Commit on a new branch and open a PR only after a yes. Variable values are never read; the user re-enters them in Capy ("Import .env" works).
- A branch that is not on origin (`branchOnOrigin` false), if they want to continue it in the cloud: `git push -u origin <branch>` from that worktree, after a yes.
- Conductor workspace notes aren't in the chats; offer to paste them into the thread if the user keeps notes there.

## Details

- Selection words the importer understands: project names, everything, latest N threads, last N days, today, last used, only unfinished, with open branches/PRs, including archived, numbers, ranges.
- Reads: Conductor `~/Library/Application Support/com.conductor.app/conductor.db` through a temporary copy; T3 Code `~/.t3/userdata/statev2.sqlite` opened `immutable=1`, never copied; session files in `~/.claude/projects` and `~/.codex/sessions` (headers only). Writes only `~/.capy-import/` (handoffs and transcripts, redacted, readable by you only) and `~/.config/import-to-capy/projects.json` (remembered projects).

## Conductor

- A Conductor **project** is a repository; a **thread** is a workspace (a git worktree under `~/conductor/workspaces/<repo>/<name>`, its branch and all its chats). Archived workspaces come only with "including archived".
- Conductor's chats are Claude Code sessions, so in Capy's Import (the optional extra) they are under **Claude Code**.
- Uncommitted work stays in the worktree; never commit, push, archive or delete anything in Conductor without a yes.
- Setup conversion: `$c2c <repo> --from-app` prints `.capy/setup.json` (`scripts.initialize` = setup script, `commands` = the Run button).
- Conductor keeps working; the user can use both.

## T3 Code

- Reads `~/.t3/userdata/statev2.sqlite` with `immutable=1` only: never copy, lock or write it (it can be gigabytes). Immutable reads skip the write-ahead log, so the last few minutes may be missing; say so if the user looks for something they just did.
- A thread's session: the provider thread's native id → `~/.claude/projects/**/<id>.jsonl` (Claude Code) or `~/.codex/sessions/**/rollout-*<id>.jsonl` (Codex). Subagent runs belong to their parent thread and come along with it.
- T3 worktrees live under `~/.t3/worktrees/`; leave them as they are.
- Project scripts: `$run setup --source t3code --project <name>` prints `.capy/setup.json` (scripts that run on worktree creation → `scripts.initialize`, the rest → `commands`).
- T3 Code keeps working; the user can use both.
