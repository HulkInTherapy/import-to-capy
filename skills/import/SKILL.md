---
name: import
description: Bring work from Conductor or T3 Code into Capy (projects, setup scripts, threads and, with consent, chat history as handoffs). Use when the user says "import", "import my threads", "bring my work over", "move from Conductor", "move from T3 Code", or asks to continue a chat from another agent app. Finds which source is on this computer, asks "Conductor or T3 Code?" only if both are, then runs one short flow - scan, pick (native form, local picker page, or a numbered menu), one-screen preview, one confirmation, import, one-screen summary with links. Read-only on the source; secrets are redacted.
---

# Import into Capy

You bring the user's own work from **Conductor** or **T3 Code** into Capy. Nothing in the source app is changed. Keep it calm and short: **one question at a time**, never a data dump.

## Scripts

`scripts/` next to this file holds zero-dependency Node scripts (Node 18+, `sqlite3` CLI). The main one:

```
node scripts/import-to-capy.mjs detect
node scripts/import-to-capy.mjs scan    --source conductor|t3code
node scripts/import-to-capy.mjs pick    --source ...                 # local picker page; prints the selection as JSON
node scripts/import-to-capy.mjs select  --source ... "<user's words>"   # prints the preview
node scripts/import-to-capy.mjs export  --source ... --threads id,id --consent [--transcripts]
node scripts/import-to-capy.mjs setup   --source t3code --project <name>
```

For Conductor setup files there is also `scripts/conductor-to-capy.mjs` (see the `import-from-conductor` skill).

## Where to run

The data lives on the user's Mac: Conductor in `~/Library/Application Support/com.conductor.app/`, T3 Code in `~/.t3/userdata/`. If `detect` finds nothing, you are probably on a cloud machine: say "Your Conductor / T3 Code data is on your Mac. Start this from a thread on your Mac (Capy desktop app → Run on → This Mac) and say import again." Then stop.

## The flow

1. **Detect.** `detect`. If both sources exist and the user didn't say which, ask exactly: **"Import from Conductor or T3 Code?"** Then hand over to `import-from-conductor` or `import-from-t3code` (same flow, source-specific details).
2. **Scan.** `scan --source X`. Don't show it yet.
3. **Pick, best UI first, and say which one you used:**
   1. If the `import-to-capy` MCP tools are available, call `choose_import`. It tries the client's native form (MCP elicitation), then a local picker page. Its result has `method`: `elicitation`, `picker` or `menu`.
   2. Otherwise, on the user's Mac, run `scan` then `pick --source X`. It opens a one-time page on 127.0.0.1 (cards, quick chips like "Latest 3", "Last 7 days", "Unfinished", checkboxes, one Import button) and prints the selection when they press Import. Tell the user: "I opened a picker in your browser." If it can't open or times out, use the menu.
   3. **Menu:** show the numbered list from `scan` and ask one question: *"Which ones? Say a number or name, everything, latest 3 threads, last 7 days, last used, only unfinished, or with open PRs. Or just say go for your most recent project's latest 3 threads."* Pass their exact words to `select`. If it returns a question, ask that question.
4. **Chats, once.** If the selection includes threads, ask once: **"Bring the chat history too? I'll write a short handoff per thread (goal, decisions, files, TODOs, last state, last few messages), with secrets redacted. Nothing is committed to main."** (Skip if the picker or form already answered `includeChats`.)
5. **Preview, then one confirmation.** Show `select`'s preview (one screen), plus for each project whether it has setup to convert. Ask: **"Import this?"**
6. **Do it.**
   - Setup: Conductor → `import-from-conductor` steps (`.capy/setup.json` on a branch, PR). T3 Code → `setup --source t3code --project <name>`; if not empty, offer the same branch + PR (or apply it with your environment tools if you are Capy and the user prefers).
   - Threads: `export --source X --threads <ids> --consent` (add `--transcripts` only if they asked for full transcripts). Handoffs land in `.capy-import/<time>/`, which git ignores.
   - **Native history first:** where a thread shows "native Claude Code / Codex session available", tell the user Capy's desktop app can import Claude Code and Codex histories as threads; our handoff is the fallback.
   - Create the Capy work: for each thread give its `capyLink` (opens a new thread with a short continue-prompt). If you are Capy and the user prefers, create one Capy issue per thread with the handoff as its body, or start the threads yourself. Never paste whole transcripts into chat.
   - Full transcripts, if wanted: commit them only on a separate branch (e.g. `capy/import-history`), never on main unless the user says so.
7. **Summary, one screen.** Projects and setup status, threads with their links, how many secrets were redacted, what could not be imported, and the few clicks left (merge the setup PR, re-enter environment variable values with Capy's "Import .env", connect a subscription).

## Rules

- **Read-only on the source.** Never write to, lock or copy T3 Code's database (`statev2.sqlite`, often gigabytes): the scripts open it with `immutable=1`. Conductor's small database is read through a temporary copy that is deleted. Never touch `~/conductor`, `~/.conductor`, `~/.t3`, `~/.capy` or app data folders.
- **Secrets:** never read or print environment values; everything written is redacted; report the count.
- **One question at a time.** Defaults need no thinking: "go" = most recent project, latest 3 threads.
- **Don't invent Capy features.** If something can't be imported, say so.
