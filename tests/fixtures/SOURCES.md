# Test fixtures: real public Conductor configs

Each file was downloaded unchanged on 15 Nov 2026 from the public repository below.
They are kept here only as test input for conductor-to-capy.

| Fixture | File(s) | Source |
|---|---|---|
| `cloudposse-docs` | `conductor.json`, `scripts/conductor-setup.sh` | https://github.com/cloudposse/docs/blob/master/conductor.json and https://github.com/cloudposse/docs/blob/master/scripts/conductor-setup.sh |
| `commonwealth` | `conductor.json` | https://github.com/hicommonwealth/commonwealth/blob/master/conductor.json |
| `clean-autofill` | `.conductor/settings.toml` | https://github.com/ZAAI-com/Clean-Autofill/blob/main/.conductor/settings.toml |
| `nextjs` (bonus) | `conductor.json` | https://github.com/vercel/next.js/blob/canary/conductor.json |

What each one exercises:
- **cloudposse-docs**: legacy file, `$CONDUCTOR_PORT` in the run script, `nonconcurrent`, a setup script file in the repo (scanned for its `npm install`).
- **commonwealth**: one long inline setup with `docker compose up`, a `.env` linked from `$CONDUCTOR_ROOT_PATH`, and `pnpm install`.
- **clean-autofill**: the current `.conductor/settings.toml` format, four named actions, one `available_in = "local"`, an undocumented key (`scripts.auto_run_after_setup`), and script files that are not in the fixture (reported as not scanned).
- **nextjs**: legacy file with fields Conductor never documented (`name`, `description`, `worktree`, `environment`, `recommendations`).
