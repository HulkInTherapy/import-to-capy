# A note for Capy's team

Hi! I'm Meghavi, a Capy user. I built **Import to Capy** because I wanted to move my Conductor and T3 Code work into Capy without retyping anything. Sharing what I learned, in case it's useful. Nothing here is a request you owe me; take whatever helps.

## What the plugin does

You say "import from conductor" (or "import from t3 code") in a thread on your Mac. The agent:

1. runs a small read-only importer on the Mac (`npx`, nothing to install) that reads Conductor's or T3 Code's local database;
2. asks at most what to bring and a final yes, with your `clarify_questions` cards;
3. writes a redacted handoff and the full redacted transcript for each picked thread to `~/.capy-import/`;
4. creates each thread with your own `thread.create` tool, in the project whose repository matches the workspace's git remote, with the original title, on the Mac, on the same branch, starting from a note that points at the handoff, the transcript and the original worktree.

No API key and no clicks after the yes. Your existing Import page (Claude Code / Codex sessions) is offered at the end for anyone who also wants the original message-by-message history; the importer tells them exactly which sessions to tick, since Conductor and T3 Code chats are ordinary Claude Code and Codex sessions underneath.

## The limits a third party runs into

1. **Plugin skills and STDIO servers don't reach threads on your own computer.** Your docs say so ("Threads on your own computer get a plugin's remote servers only"). A migration tool has to run where the old app's data is, the user's Mac, so the skills never load there. I worked around it with a tiny stateless remote MCP server (`https://import-to-capy-mcp.vercel.app/mcp`) that only hands the agent the same playbook the skills contain.
2. **No way to create a project, or link a folder to one, from a plugin or the API.** When a repository has no Capy project yet, the best I can do is ask the user to create it by hand and wait.
3. **No public thread-creation contract for plugins.** The agent's `thread.create` works well, but its shape isn't documented for plugin authors (the agent, reasonably, won't quote its schema), and it can't start a thread inside an existing folder such as a Conductor worktree, only a new worktree or the project's linked folder. So a plugin can't promise "same folder", and the playbook has to say "check `describe` first".

## Small things that would make this native

- **"Import from Conductor / T3 Code" in the existing Import page.** It already parses their Claude Code and Codex sessions. Labelling sessions under `~/conductor/workspaces/…` and `~/.t3/worktrees/…` with their workspace or thread names would make Import the whole migration path for both apps.
- **A project per Conductor / T3 Code project.** During import, offer to create the matching Capy project (same repository, or the same folder on this Mac) so threads land together.
- **Plugin skills on threads on your own computer**, so a plugin that works on local data doesn't need a remote server just to deliver instructions.
- **A public `thread_create` / import API for plugins**, ideally with a folder (existing worktree) option and file attachments, documented like the REST API.
- **A deep link that preselects sessions and a project**, e.g. `capy://app/settings/import?source=claude-code&sessions=…&project=…`, so a skill could hand over exactly what it found.

Thanks for building Capy. The source is MIT-licensed at https://github.com/HulkInTherapy/import-to-capy if any of it is useful.
