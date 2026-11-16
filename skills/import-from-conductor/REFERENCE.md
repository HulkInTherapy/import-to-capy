# Conductor → Capy: every mapping rule

Use this when the scripts can't run, or to check what they did. Sources: Conductor's docs (conductor.build/docs: Scripts, Settings, Settings reference, conductor.json, Environment variables, Files to copy, .worktreeinclude, Cloud Computer) and Capy's docs (docs.capy.ai: Environment, Secrets, Desktop, Dock, Instructions, Reviews, Plugins), read on 15 Nov 2026.

## Where Conductor keeps configuration

| Place | Format | Notes |
|---|---|---|
| `.conductor/settings.toml` | TOML, schema `settings.repo.schema.json` | Shared, committed. Keys below. |
| `.conductor/settings.local.toml` | same | Personal, gitignored (often a symlink inside workspaces). Wins over `settings.toml`. May hold secrets: read names only. |
| `~/.conductor/settings.toml` | TOML, schema `settings.schema.json` | User settings (`models.default`, `git.branch_prefix_type`...). Report the default model only. |
| `conductor.json` | JSON: `scripts.setup`, `scripts.run`, `scripts.archive`, `runScriptMode`, `enterpriseDataPrivacy` | Legacy. Ignored when `settings.toml` exists. |
| `.worktreeinclude` | gitignore patterns | Gitignored files copied into each local workspace. |
| Conductor app | SQLite in WAL mode, `~/Library/Application Support/com.conductor.app/conductor.db`; table `repos` (`setup_script`, `run_script`, `run_script_mode`, `archive_script`, `conductor_config`, `custom_prompt_*`, `file_include_globs`, `default_branch`, `root_path`, `remote_url`), table `env_vars` (`key`, `scope`, `context`, `value`) | Current app versions save settings here and no longer read the files after a one-time import. Copy `conductor.db`, `-wal` and `-shm` to a temp folder, query the copy, delete it. Never select `env_vars.value`. `root_path` is the main checkout, not the worktree. |
| Conductor Cloud | organization settings on Conductor's servers | Not readable from the repo. Ask the user to paste the Cloud Computer install script and each repository's setup script. |
| Workspaces | git worktrees under `~/conductor/workspaces/<repo>/<name>` (older: `.conductor/` inside the repo); archived ones in `~/conductor/archived-contexts/`; app table `workspaces` (`directory_name`, `workspace_name`, `branch`, `state`, `pr_title`, `pr_description`, `notes`, `intended_target_branch`, `workspace_path`) | Chats: `sessions` (`workspace_id`, `title`, `status`, `agent_type`, `claude_session_id`) and `session_messages` (`session_id`, `role`, `content`). Read message text only with the user's yes, summarise in one line, never copy it. |

`settings.toml` keys: `scripts.setup`, `scripts.archive`, `scripts.run_mode` (`concurrent`/`nonconcurrent`), `scripts.run.<name>.{command,args,options.cwd,default,icon,hide,available_in}`, legacy `scripts.run` (string), `enterprise_data_privacy`, `spotlight_testing`, `file_include_globs`, `preview_urls[] {name,url}`, `environment_variables` (+ `.local`, `.cloud`), `prompts.{general,code_review,create_pr,fix_errors,resolve_merge_conflicts,rename_branch}`, harness keys (`claude_code_executable_path`, `claude_provider`, `bedrock_region`, ...), `git.*`.

Conductor variables: `CONDUCTOR_WORKSPACE_NAME`, `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_DEFAULT_BRANCH`, `CONDUCTOR_PORT` (first of 10 ports, local only), `CONDUCTOR_IS_LOCAL`, `CONDUCTOR_BASE_DIR`, `CONDUCTOR_API_*`.

## What Capy reads

`.capy/setup.json`, committed to the project's base branch (Capy reads it from GitHub, never from a machine):

```json
{
  "$schema": "https://api.capy.ai/schemas/setup.v1.json",
  "format_version": 1,
  "scripts": { "initialize": "...", "refresh": "..." },
  "timeouts": { "initialize": 900 },
  "startup": [ { "name": "db", "command": "docker compose up -d --wait postgres" }, { "name": "web", "command": "pnpm dev", "port": 3000 } ],
  "commands": [ { "name": "test", "command": "pnpm test" } ]
}
```

Scripts run from the repository directory in bash with the project's environment variables loaded, on Ubuntu 24.04 with passwordless sudo. The file never carries machine size, branch, or variables. Alternatively, Capy's own agent can write the same setup through its environment tools (no file).

## Mapping

| Conductor | Capy | Rule |
|---|---|---|
| Setup script | `scripts.initialize` | Copy as-is. |
| Dependency install inside setup (`pnpm install`, `npm ci`, `yarn install`, `bun install`, `bundle install`, `uv sync`, `poetry install`, ...) | `scripts.refresh` | Copy just the install command. Leave refresh empty if none. |
| Run (legacy string) | `commands: [{ name: "run", ... }]` | On demand, like the Run button. |
| Action `scripts.run.<name>` | `commands: [{ name, command }]` | `command` + `args` (keep `$VARS` expandable) ; `options.cwd` becomes `cd <cwd> && `. Drop `icon`. Include hidden ones. |
| `available_in = "local"` | (skipped) | Report it. Cloud machines are Linux VMs. |
| `$CONDUCTOR_PORT` / `$((CONDUCTOR_PORT + n))` in a command | `"port": 3000 (+n)` | Capy publishes a preview for each entry with a port. |
| Any `CONDUCTOR_*` variable used | `.capy/conductor-env.sh` sourced first: `. ./.capy/conductor-env.sh && <cmd>` | Shim sets `CONDUCTOR_WORKSPACE_PATH=$PWD`, `CONDUCTOR_ROOT_PATH=$PWD`, `CONDUCTOR_WORKSPACE_NAME=$(basename $PWD)`, `CONDUCTOR_DEFAULT_BRANCH=<base>`, `CONDUCTOR_IS_LOCAL=0`, `CONDUCTOR_PORT=3000`, each only if unset. That is how Conductor Cloud behaved. |
| `.env` linked or copied from `$CONDUCTOR_ROOT_PATH` | Project environment variables | No separate main checkout on Capy; with the shim `ln -s` would link `.env` to itself. Move values to Capy variables, or guard with `[ "$CONDUCTOR_IS_LOCAL" = 1 ]`. |
| `docker compose up` in setup | add `startup: [{ name: "services", command: "docker compose up -d --wait" }]` | Containers stop when a Capy machine sleeps. |
| Archive script | (none) | Report. Machines sleep and are deleted. |
| `run_mode` | (none) | Each cloud thread has its own VM. Local threads can still collide. |
| `environment_variables`, `environment_variables.cloud` | Project → Environment variables (Shared) | Names only on the checklist. Never put values in the file. `.local` ones: skip. |
| `.worktreeinclude`, `file_include_globs` | Variables (cloud) or "Current checkout" (desktop app) | Cloud machines never see files on the user's Mac. |
| `prompts.general`, `create_pr`, `fix_errors`, `resolve_merge_conflicts`, `rename_branch` | `AGENTS.md` | Offer to append. |
| `prompts.code_review` | `AGENTS.md` under `## Reviews` | Capy's review agent enforces rules written there. |
| `preview_urls` | `port` on entries | |
| `spotlight_testing` | (none) | Closest: a desktop thread on "Current checkout", or "Continue on" to the user's machine. |
| `enterprise_data_privacy` | Capy Enterprise: zero data retention on request | Or run threads on the user's own computer. |
| `git.*` | (none) | Capy uses `capy/…` branches, never pushes to main/master/develop/release/*, never merges unless asked. |
| Harness keys | Settings → Models | Claude Code setup token, Codex device code, keys and gateways (Bedrock included). |
| `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.claude/skills`, `.agents/skills` | read as-is | No change. `CLAUDE.md` is a fallback when there is no `AGENTS.md`. |
| `.mcp.json` | Settings → MCP & plugins → Advanced (paste) | Secret references are not imported. |
| Unknown keys | (none) | Report. Do not guess. |

## In-flight workspaces

1. `git worktree list --porcelain` from the main checkout (the parent of `git rev-parse --git-common-dir`). Worktrees under `/conductor/workspaces/` or `/.conductor/` are Conductor's.
2. For each: branch, `git rev-list --count origin/<base>..<branch>`, `git status --porcelain` count, whether `origin/<branch>` exists.
3. In the cloud: `git for-each-ref --no-merged=origin/<base> refs/remotes/origin`.
4. Prompt per branch, opened with `https://capy.ai/new?prompt=<url-encoded prompt>` (Capy fills a new thread's composer with it): "Continue work moved over from Conductor on branch `X` ... read its diff against `<base>` ... tell me where it stands ... wait for my go-ahead."
