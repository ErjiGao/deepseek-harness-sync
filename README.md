# deepseek-harness-sync

English | [中文](README.zh.md)

Sync a whole DeepSeek Harness (DSH) installation across machines through **your own private GitHub
repository**.

```text
device A: home + workspace  →  harness-sync push  →  your private repository
                                                            ↓
device B: home + workspace  ←  harness-sync pull  ←  your private repository
```

Two directories, not one. `$DSH_HOME` holds the harness configuration; the **workspace** is the
directory you actually work in, which carries its own session configuration, skills, and cloned
repositories. Both travel; see §9.

---

## 1. What it does, and what it refuses to do

**Does**

- Read a **whitelisted** set of files under `$DSH_HOME` (see §9) and pack them, **verbatim**, into a
  versioned snapshot.
- Read a **pattern-whitelisted** set of files from the session workspace, and record the git
  repositories inside it as **clone references** rather than copying their contents.
- Push that snapshot to your private repository, or pull and apply it, using `git`.
- Back up the current configuration — both directories — before every overwrite, keeping the last 5,
  restorable with `rollback`.

**Refuses to**

- **Parse, interpret, or rewrite your configuration.** `settings.yaml` is stored byte-for-byte, so your
  comments, anchors and formatting survive.
- Sync session logs, attachments, telemetry databases, or `node_modules`.
- Sync research data, build output, or anything holding a credential. The workspace layer has a
  **hard deny-list** that runs before its allowlist, so `.env`, `*.pem`, `id_rsa`, `credentials.json`
  and a directory named `secrets/` are refused even inside an allowlisted tree.
- **Copy a git repository's working tree into the configuration repository.** Repositories are recorded
  by URL, branch and commit, and a `workspace-repos.sh` script is generated to clone them.
- Touch credentials. No token ever reaches the repository, the plugin's config, or a log line.
- Introduce a database, server, Docker, accounts, or a third-party sync service.

---

## 2. Two hard prerequisites

### 2.1 The configuration repository **must** be private

It will contain your **machine names**, your **plugin list**, and your **`settings.yaml`**. `init` does its
best to stop you:

- With a token available, it queries the GitHub API and asserts `private === true` — a **public repository
  fails outright**.
- Without a token the API cannot be queried (a credential helper only serves `git`), so it **warns loudly**
  and asks you to confirm.

### 2.2 Git, with credentials that can push

`harness-sync` drives `git`. That is not a compromise: history, conflict detection and cross-platform
credential management come for free. See §6.

---

## 3. Architecture: one core, three front doors

```text
terminal   ──►  bin/harness-sync.js   (CLI)           ─┐
                                                       │
chat / GUI ──►  lib/index.js          (DSH host plugin)├─►  lib/core/*   all the logic
                  · 4 tools (model-facing)             │
                  · /harness-sync (human-facing)       │
                  · lib/host/api.js (loopback bridge)  │
                                                       │
Settings   ──►  lib/client.js         (browser plugin) ─┘
                  · a "Configuration Sync" page
                  · a one-click "Upload to GitHub" button
```

All three run the same `lib/core`, so `harness-sync push` in a terminal, `/harness-sync push` in a conversation,
and the **Upload to GitHub** button in Settings behave identically and cannot drift apart.

**On `dsh` subcommands**: DSH does **not** let a plugin register a CLI subcommand. The `dsh` grammar is
fixed — default boot, `dsh web`, `dsh plugin`. So `harness-sync` is a **standalone executable**, not
`dsh harness-sync`. That is an architectural boundary, not a shortcut.

The CLI runs without DSH: **it works whether or not the harness is running**. The plugin half is optional.

---

## 4. Installation

### Option A — from your GitHub repository (recommended for a new machine)

```bash
dsh plugin --profile web add github:<your-account>/deepseek-harness-sync
```

If `dsh` is not on `PATH`:

```bash
npx @deepseek-ai/dsh plugin --profile web add github:<your-account>/deepseek-harness-sync
```

> This package is **zero-build** — no `prepare` script, no dependencies. That matters: pnpm blocks build
> scripts for packages installed from Git, so a plugin that needs building cannot be installed until you
> hand-edit `allowBuilds` on every new machine. This plugin deliberately avoids that trap, so a `github:`
> install just works and needs no Node toolchain on the target.

### Option B — from a local checkout

```bash
git clone https://github.com/<your-account>/deepseek-harness-sync.git
dsh plugin --profile web add /absolute/path/to/deepseek-harness-sync
```

### Activating

`dsh plugin` **automatically** appends the package to the profile's `dsh.profile.bundles` (because the
package declares `dsh.bundle`), so no file needs editing by hand. Then **restart `dsh web`**.

### Finding the CLI

After a profile install, `harness-sync` lives at:

```text
$DSH_HOME/profiles/web/node_modules/.bin/harness-sync
```

Any of these work:

```bash
# 1. the installed shim (add .cmd on Windows)
"$DSH_HOME/profiles/web/node_modules/.bin/harness-sync" status

# 2. straight from the checkout — always available
node /absolute/path/to/deepseek-harness-sync/bin/harness-sync.js status

# 3. recommended: an alias
alias hsync='node /absolute/path/to/deepseek-harness-sync/bin/harness-sync.js'
```

> **Installing the plugin and restoring your configuration are two separate things.** The plugin comes from
> the *plugin* repository; the configuration comes from a *different* private repository. Keeping them
> apart is what stops the plugin from depending on any one machine.

---

## 5. Creating the configuration repository (**must be private**)

1. Open <https://github.com/new>.
2. Name it something like `deepseek-harness-config`.
3. **Select Private.** Do not skip this.
4. Leave "Add a README" / `.gitignore` / license unchecked — an empty repository is simplest. (If you do
   tick them, the first `push` simply builds on top.)
5. Create repository.

The plugin then produces this layout — **do not hand-edit it**:

```text
deepseek-harness-config/
├── config/
│   └── harness-config.json   # the snapshot: version, timestamp, device, each file verbatim
├── metadata.json             # small index: version, timestamp, device, per-file sha256
├── README.md
└── .gitignore                # a second line of defence for secrets
```

### Reusing a repository you already have

If you already have a repository (one another tool writes to, say), it can be reused directly — nothing
already in it is destroyed:

```bash
harness-sync init --url https://github.com/<you>/DSH-Sync-Data.git --branch main
```

The four paths are handled differently on collision:

| Path | On collision |
|---|---|
| `config/harness-config.json` | ours alone, rewritten every time |
| `metadata.json` | ours alone, rewritten every time |
| `README.md` | written **only when absent, or when it is already ours**. A foreign README is left untouched and reported as `kept the repository's own README.md` |
| `.gitignore` | created when absent; when present, this plugin's marked block is **appended** (idempotently — a second push never duplicates it) |

Measured against a **mirror of a real repository holding 88 files and its own README**: after a push the
original README was byte-identical, all 88 files survived, and only `.gitignore`,
`config/harness-config.json` and `metadata.json` were added.

> Tools such as `dsh-config-manager` use a `snapshots/<uuid>/…` layout; this plugin uses `config/` and
> `metadata.json`. The filenames do not collide, so the two can share one repository indefinitely.

---

## 6. Authentication

Three routes, in priority order.

### 6.1 The system Git credential helper (default, recommended)

**Nothing to configure.** Run `harness-sync push` and Git Credential Manager (Windows/macOS) or libsecret
(Linux) signs you in through a browser once, then keeps working.

On this route **no token ever passes through this plugin** — it is not read, written, printed, or stored.

### 6.2 Environment variables (CI, or a machine with no credential manager)

```bash
export GH_TOKEN=github_pat_xxx      # or GITHUB_TOKEN
```

**Least privilege**: create a **fine-grained PAT** with

- Repository access → **Only select repositories** → just `deepseek-harness-config`;
- Permissions → Repository permissions → **Contents: Read and write** (that one, nothing else);
- whatever expiry you want.

The plugin hands the token to `git` through `GIT_CONFIG_COUNT` environment variables. Verified behaviour:

| Requirement | Met |
|---|---|
| Not written to Git (remote URL, `.git/config`) | ✅ the token enters no file |
| Not written to the configuration repository | ✅ |
| Not in logs or the terminal | ✅ every git stream is redacted before it is shown |
| No `--token` argument | ✅ deliberately unsupported — argv is visible to other processes on the machine |
| Least privilege | ✅ fine-grained PAT, `Contents: Read and write` only |

### 6.3 GitHub CLI

If `gh` is installed and logged in, the plugin picks up `gh auth token` automatically and uses route 6.2.
Having no `gh` is fine.

> **OAuth Device Flow is not implemented** (deferred). It needs you to register a GitHub OAuth App just to
> obtain a client_id, and then needs somewhere safe to keep the resulting token — more setup than any of
> the three routes above.

---

## 7. First-time setup

```bash
harness-sync init
```

It asks:

```text
GitHub username: your-account
Repository name [deepseek-harness-config]:
Branch [main]:
```

and then verifies reachability and privacy. Non-interactively:

```bash
harness-sync init --user <account> --repo <repo> --branch main
harness-sync init --url https://github.com/<account>/<repo>.git
```

`init` writes `$DSH_HOME/harness-sync/config.json`. That record **structurally has no token field**, and
reading one back is an error.

---

## 8. Everyday use

### `push` — upload this machine's configuration

```bash
harness-sync push
```

```text
Push
  Repository:             https://github.com/you/deepseek-harness-config.git
  Branch:                 main
  Device:                 DESKTOP-ABC
  Version:                4 → 5
  Files:                  7
OK    pushed version 5 to main
```

`push` only ever **reads** the local configuration. It applies two guards:

1. a **credential screen** before anything is staged (see §10);
2. **no overwriting a moved remote** — if the repository advanced since this machine last synced, it stops
   and offers three choices (see §8.4).

### `pull` — apply the repository's configuration

```bash
harness-sync pull
```

```text
OK    backed up current configuration to .../backup/harness-config-2026-09-15-1830.json
  written  settings.yaml
  same     profiles/web/cordis.yml
OK    applied version 5
```

**Every pull backs up first.** Not optional, not prompted.

### `sync` — pull, inspect, then synchronize

```bash
harness-sync sync
```

| local vs remote | action |
|---|---|
| identical | report `already synchronized`, write nothing |
| remote newer, local clean | pull automatically |
| local changed, remote unmoved | push automatically |
| **both sides have content / both moved** | **stop**, show the menu, exit code 2 |

In particular, a brand-new machine running `sync` for the first time **stops** rather than replacing the
real configuration in your repository with a fresh install's defaults.

### `status` — where things stand

```bash
harness-sync status
```

```text
GitHub repository: connected
Local config: found
Remote config: found

Local version: 5
Remote version: 4

Status: local configuration has unpushed changes
```

A detail block follows (repository, branch, profile, device, authentication route, last sync time, the
per-file list, and any machine-local dependency warnings).

| `Status` | Meaning | Exit |
|---|---|---|
| `synchronized` | both sides agree | 0 |
| `local configuration has unpushed changes` | local ahead | 1 |
| `remote configuration is newer` | remote ahead | 1 |
| `diverged — both sides changed` | both moved | 2 |
| `the configuration repository could not be reached` | network/auth | 1 |
| `this device is not initialized` | no `init` yet | 1 |

### `diff` — file by file

```bash
harness-sync diff
```

```text
Differences — left is this device, right is DESKTOP-XYZ
  "-" lines are only here, "+" lines are only in the repository

settings.yaml:
  @@ after 2 unchanged line(s) @@
  -   model: device-a
  +   model: device-b
```

### 8.4 Conflicts

Versioning: this machine records `localVersion` (its snapshot version) and `baseVersion` (the **remote**
version at its last successful sync). `push` fetches first; if `remoteVersion > baseVersion` the remote
moved without this machine knowing, so:

```text
Remote configuration has changed.

Local:  version 12
Remote: version 11

Please choose:

1. Pull remote configuration      harness-sync pull
2. Force push local configuration harness-sync push --force
3. Show differences               harness-sync diff
```

In a terminal this is an interactive numbered menu. In a GUI slash command or a script (non-interactive) it
prints the block above and exits **2**.

> **What `--force` actually means.** It is **not** `git push --force`. Every run first resets the local
> working clone to the remote's tip and then *appends* a new version, so the push is **always a
> fast-forward**. It overrides the configuration *content*; it **never rewrites or discards remote
> history**. The repository still reads `v1 → v2 → v3`, and you can go back to any step. A "force push"
> here remains recoverable.

### `rollback` — restore a backup

```bash
harness-sync rollback --list    # newest first
harness-sync rollback           # restore the newest
harness-sync rollback --to 2    # by index from the list
harness-sync rollback --to harness-config-2026-09-15-1830.json
harness-sync rollback --to D:/somewhere/my-export.json   # or a path to an exported snapshot
```

**A rollback is itself reversible**: it backs up the state it is about to replace.

> Through the HTTP bridge (the Settings page), `to` accepts only an **index** or a **file name** — never a path,
> so the browser side cannot name an arbitrary file.

### `export` — write the current configuration to a file

```bash
harness-sync export
```

```text
Export
  File:                   harness-config-2026-09-15-1932.json
  Location:               ~/.dsh/harness-sync/exports/harness-config-2026-09-15-1932.json
  Files:                  7
  Profile:                web
OK    wrote a restorable snapshot of this device
```

- Exports go to **`exports/`**, separate from the `backup/` rotation that `pull` maintains: `backup/` is pruned to
  the retention count, while `exports/` is **never deleted automatically** — something you deliberately asked for
  must not be swept away by the next pull.
- An export is an ordinary snapshot, so `harness-sync rollback --to <path>` restores it directly.
- In the Settings page, **Export a backup** makes the host write it and then triggers a browser download, so the
  file ends up in your download folder *and* stays in `exports/`.

### In the Web GUI / a conversation

The plugin registers 4 tools (model-facing) and 1 slash command (human-facing):

| Tool | Purpose |
|---|---|
| `harness_sync_status` | read-only status |
| `harness_sync_push` | upload (`force`, `dryRun`) |
| `harness_sync_pull` | apply (`dryRun`) |
| `harness_sync_rollback` | restore a backup (`list`, `to`) |

```text
/harness-sync status
/harness-sync push
/harness-sync sync
/harness-sync rollback --list
```

### One-click sync from the Settings page (no terminal)

The plugin registers a page of its own in the **Settings** panel: **"Configuration Sync"** (`order: 60`, after the
shipped pages). **After restarting `dsh web`**, open Settings from the sidebar and it appears in the navigation.

| Control | Effect |
|---|---|
| **Upload to GitHub** (primary) | `push` — commit this machine's configuration as a new version and push it |
| Pull | `pull` — apply the repository's configuration (backs up first) |
| Sync | `sync` — compare both sides, then decide; **never overwrites silently on divergence** |
| Export a backup | `export` — write the current configuration to a snapshot file and have the browser save it to this machine |
| Refresh | re-read status |
| Advanced ▸ dry-run push / dry-run pull / list backups / roll back / force upload | `--dry-run`, `--list`, `rollback`, `--force` |

The page also shows the repository, branch, device name, local and remote versions, last sync time, the
authentication route, **whether the repository is private and whether that was actually verified**, the per-file
list, and the **`link:` dependency warnings that will break on another machine**. Each action's full command
output is rendered below the buttons.

**Before initialization** the page becomes a connection form: enter the repository URL and branch and press
Connect, which runs `init` — and it shows *what would be uploaded* before you connect anything.

> Colours come from the theme's own `--dsw-*` tokens (each with a fallback), so the page matches light, dark and
> third-party themes. It is a **hand-written browser bundle** (`lib/client.js`) with **no JSX and no build step** —
> see §14 for why.

#### The page's security boundary

The browser half is a static asset and cannot call the kernel's `/api`, so the host half claims a private route
prefix (`/harness-sync/api/*`) on the **loopback web server** and the page uses same-origin `fetch`. That sits
outside the kernel's `/api` cookie fence, so every request passes three checks:

1. the peer socket must be **loopback** (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`);
2. **`Sec-Fetch-Site: cross-site` is refused outright** (the browser sets it; a page cannot forge it), and a
   present `Origin` must match the request's `Host`;
3. anything that **changes** state is **POST-only** (`init`/`push`/`pull`/`sync`/`rollback`); `status` is GET-only.

An unknown endpoint returns **404** rather than falling through to a command and answering 200, and no response
ever contains a credential.

---

## 9. What is synced, and what never is

### Synced — a **whitelist**, never "walk everything and exclude"

**The harness home.** A finite, known set of files, named explicitly:

| Path (relative to `$DSH_HOME`) | Contents |
|---|---|
| `settings.yaml` | the user-settings document (theme, locale, default model, default preset…) |
| `profiles/<profile>/package.json` | `dsh.profile.bundles` + `patchReload` — **this is how plugins travel** |
| `profiles/<profile>/cordis.patch.yml` | your patch layer |
| `profiles/<profile>/cordis.yml` | the profile root the launcher expects |
| `profiles/<profile>/pnpm-workspace.yaml` | linker / `allowBuilds` policy |
| `profiles/<profile>/pnpm-lock.yaml` | exact versions |
| `profiles/<profile>/.dsh-market/state.json` | which bundles you disabled |
| `.agent-presets/**` | your own agent presets (**only if present**) |
| `skills/**` | your skills (**only if present**) |
| `AGENTS.md` | the user-global instruction baseline (**only if present**) |
| `cordis.patch.yml` (home root) | the home patch layer, which outranks the per-profile one (**only if present**) |

**The workspace.** A directory whose contents cannot be enumerated in advance, so the rule is a
pattern allowlist with a **deny-list in front of it**. Point at it with `--workspace <dir>` or
`$DSH_WORKSPACE`; without one, only the home is synced.

| Workspace-relative pattern | Why |
|---|---|
| `.dsh/**` | the workspace's own harness config and its installed skills — the most important thing here |
| `.agent-presets/**`, `skills/**` | workspace-scoped skills and presets |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules` | agent instruction baselines |
| `.editorconfig`, `.gitattributes`, `.gitignore` | repository housekeeping that is configuration |
| `README.md`, `NOTES.md`, `TODO.md` | the plain notes worth carrying |

Widen it per workspace with `.dsh/sync.json`, which itself lives in the workspace because the
workspace is what moves:

```json
{ "include": ["src", "notes/keep.md"], "exclude": ["src/vendor"] }
```

An `include` **cannot** override the deny-list: `{"include": ["src"]}` still never captures `src/.env`.
A malformed `sync.json` falls back to the safe defaults rather than widening what is synced.

### Recorded as references, not copied

A git working tree inside the workspace is captured as `{path, remote, branch, head}` and **not**
descended into. Copying it would duplicate what `git clone` does, pull build output and history into
the configuration repository, and destroy the ability to `git pull` updates afterwards. `push` writes
two derived files so a restore needs no JSON parsing:

- `config/workspace-repos.json` — the machine-readable list;
- `workspace-repos.sh` — a POSIX script that clones each repository, **skips one that already exists,
  and never deletes anything**. It is generated, not executed: cloning runs with your privileges and
  hits the network, which is not a thing a sync should do behind your back.

A repository with no `origin` remote is recorded by path and reported as **not reproducible** — its
contents are not copied, and the script says so rather than pretending.

### Never synced

| Category | Examples | Why |
|---|---|---|
| **Secrets** | `.credentials.yaml`, `dsh-pocket/token`, `.env`, `*.pem`, `id_rsa`, `credentials.json`, anything under `secrets/` | they are secrets |
| **Workspace data** | `water_density/`, `output/`, unlisted `*.csv`, anything over 1 MiB | measured here: one research directory was 569 MB of the workspace's 695 MB |
| **Machine-specific** | `bin/dsh.cmd`, `profiles/node_modules/`, the workspace *path itself* | hard-coded local paths / rebuildable |
| **Runtime state** | `sessions/`, `attachments/`, `storages/`, `tokenledger.sqlite*`, `llm-deepseek/` | sessions and telemetry, and large |
| **Build output** | `node_modules/`, `dist/`, `build/`, `target/`, `__pycache__/`, `.venv/` | restorable with a package manager |

`$DSH_HOME/.env` is **deliberately** excluded: DSH allows proxy credentials in that file and nowhere else.
To sync proxy settings, configure git instead (§11).

The workspace root is a property of the machine, not of the configuration: a recorded
`/home/alice/work` means nothing on another device. It is resolved from `--workspace`, then
`$DSH_WORKSPACE`, then the path `init` recorded for this device — **never from the snapshot**. If a
pull arrives carrying workspace files and this machine has no workspace configured, the pull **refuses
and writes nothing**, rather than applying half a snapshot or inventing a directory.

### 9.1 A new machine, end to end

On the **machine you are leaving** (or before you wipe it):

```bash
harness-sync init --url https://github.com/<you>/DSH-Sync-Data.git --branch main
harness-sync push --workspace /path/to/your/workspace
harness-sync status                       # should say "synchronized"
```

On the **new machine**, in order:

```bash
# 1. Get the tool itself. It is a plugin, so a profile must exist first.
dsh plugin --profile web add github:<you>/deepseek-harness-sync

# 2. Connect this device to the same private repository.
harness-sync init --url https://github.com/<you>/DSH-Sync-Data.git --branch main

# 3. Apply the configuration — BOTH directories.
harness-sync pull --workspace /path/on/this/machine

# 4. Rebuild the plugins the profile lists.
cd ~/.dsh/profiles/web && pnpm install
#    Windows: %USERPROFILE%\.dsh\profiles\web

# 5. Re-clone the workspace's repositories.
cd /path/on/this/machine && sh workspace-repos.sh

# 6. Restart DeepSeek Harness so the restored bundle list takes effect.
```

Two things are deliberately **not** automatic, and both are the reason `pull` prints what it did:

- **Step 5 does not happen during `pull`.** The clone script is written into the configuration
  repository rather than run for you. A sync that silently clones four repositories the moment you
  pull is a sync you cannot audit. It is waiting in the local clone that `init` made, which is
  `$DSH_HOME/harness-sync/repo` — so on the new machine:

  ```bash
  sh ~/.dsh/harness-sync/repo/workspace-repos.sh
  # Windows: %USERPROFILE%\.dsh\harness-sync\repo\workspace-repos.sh
  ```

  Run it from the workspace root: its paths are workspace-relative so the same script works whatever
  the workspace is called on this machine. `config/workspace-repos.json` holds the same list in
  machine-readable form if you would rather do it by hand.
- **Step 4 is a package manager, not a sync.** `pnpm-lock.yaml` travelled, so the versions are pinned,
  but installing is a decision about this machine.

---

## 10. Security

### 10.1 Why a whitelist rather than "walk and exclude"

Because this was measured on a real installation:

| File | SHA-256 |
|---|---|
| `$DSH_HOME/.credentials.yaml` | `85AC4345…64CE` |
| `$DSH_HOME/dsh-config-manager/vault/.credentials.yaml` | **the same hash — a byte-identical plaintext copy** |

A third-party plugin can keep a plaintext copy of your credential store in its own directory. Any
"recursively walk `$DSH_HOME`, skip `*.credentials.yaml`" implementation would upload it.

So `lib/core/manifest.js` **never enumerates `$DSH_HOME`**; every path is named explicitly. And
`assertManaged()` re-validates every path in a snapshot **before a byte is written**, refusing absolute
paths, drive letters, UNC paths, `..`, backslashes, NUL, and anything outside the whitelist. A regression
test asserts that **no collected file has the credential store's hash**.

### 10.2 `settings.yaml` is not inherently safe

The settings service supports `role('secret')` fields, a shipped plugin declares one
(`dsh-web-search-deepseek` declares `apiKey`), and the file-backed provider has **no** `${env:VAR}`
indirection — so a key typed into the UI sits in `settings.yaml` in plaintext.

Hence two screens before publishing:

1. **Content shapes**: `ghp_` / `github_pat_` / `sk-` / `AKIA` / `AIza` / `xox*` / JWT / `-----BEGIN … PRIVATE KEY-----`.
2. **Leaf key names**: `apiKey` / `token` / `secret` / `password` / `credential` … where the value looks
   literal (not `${env:…}`, not an ALL_CAPS environment-variable name).

A hit **refuses the push** (exit 1) and **never echoes the matched value** — only the file and line.

### 10.3 Sandbox disclosure

The `git` process this plugin spawns is **not confined by the DSH sandbox**; it runs with your full user
privileges. That is necessary (it reads and writes `$DSH_HOME`), but it means: run this on your own
machine, and point it only at your own private repository.

### 10.4 Deletion semantics (know this)

`pull` **deletes** whitelisted fixed files that the snapshot records as explicitly absent — for example, if
the source machine has no `AGENTS.md` and yours does. That is how a removal propagates. Because every pull
backs up first and prints `deleted <path>`, it is undoable — but it does delete files.

---

## 11. Troubleshooting

### `cannot reach the repository` / `Failed to connect` / `Connection was reset`

The machine cannot reach GitHub, or needs a proxy. First confirm git itself can connect:

```bash
git ls-remote https://github.com/<you>/<repo>.git
```

If you need a proxy, configure git (**the one recommended place for it**):

```bash
git config --global http.proxy  http://host:port
git config --global https.proxy http://host:port
```

### `Authentication failed` / `could not read Username`

Git has no credential. Any one of:

1. run any git command against the repository in a terminal so Git Credential Manager can prompt;
2. `export GH_TOKEN=...` (fine-grained PAT, `Contents: Read and write`, that one repository only);
3. `gh auth login`.

`harness-sync` always sets `GIT_TERMINAL_PROMPT=0`, so it **never hangs** waiting for input; Credential
Manager's GUI/browser flow is unaffected.

### `repository not found`

A misspelled repository, or a credential without access to it (GitHub returns 404 for a private repository
you cannot see).

```bash
harness-sync status        # shows the configured repoUrl and branch
```

Re-run `init` to change it — the recorded version history is preserved.

### `refusing to push: N credential-like value(s) found`

The screen matched something. It **will not repeat the value** (deliberately); it names the file and line.

Open that file, replace the literal with a runtime environment reference (or change how DSH stores it),
then push again. If it is a genuine false positive — a field named `token` whose value is not a secret —
rename the field.

### pnpm says `Ignored build scripts` when installing from `github:`

This package is **zero-build**, so this should not happen. If it does, you are installing something else, or
you added a `prepare` script while modifying this plugin. The fix is to add the key to `allowBuilds` in
`$DSH_HOME/profiles/web/pnpm-workspace.yaml` — but the better fix is to **not add a build step**, which is
exactly why this plugin has none.

### `link:` / `file:` dependency warnings

`push` and `pull` report things like:

```text
WARN  2 dependency spec(s) point at a directory on THIS machine and will not resolve elsewhere:
         profiles/web/package.json:11  link:D:/somewhere/dsh-gaussian-dft
         profiles/web/pnpm-lock.yaml:27  link:D:/somewhere/dsh-vasp-dft
```

**These are synced as-is** (the plugin will not rewrite them for you). On the new machine you decide:

- publish or clone that plugin and point the entry at the new location; or
- remove it from `dsh.profile.bundles` and `dependencies`, then `pnpm install`.

### `pnpm install` fails on a new machine

Almost always the `link:` dependencies above. In the profile directory:

```bash
cd "$DSH_HOME/profiles/web"
pnpm install --no-frozen-lockfile
```

(A lockfile carrying machine-local paths fails the frozen check.)

### `Status: the configuration repository could not be reached`

Same as above — fix network/auth first. `status` prints git's own error alongside the hint.

### The version numbers look wrong

`localVersion` is the version this machine's content corresponds to; with unpushed local changes it is
displayed as `localVersion + 1`, i.e. **the version it would be pushed as**. `remoteVersion` is the remote
snapshot's version. Only equal versions *and* equal content read as `synchronized`.

### Uninstalling completely

```bash
dsh plugin --profile web remove deepseek-harness-sync
```

`dsh plugin` removes it from `dsh.profile.bundles` automatically. Then delete, as you wish:

```text
$DSH_HOME/harness-sync/            # this plugin's data: config.json, repo/, backup/
```

The configuration repository lives on GitHub and is yours to delete.

---

## 12. Command reference

```text
harness-sync <command> [options]

init       connect a private configuration repository
status     compare this device against the repository
push       upload this device's configuration
pull       apply the repository's configuration here
sync       pull, inspect the difference, then synchronize
diff       show what differs, file by file
rollback   restore a local backup
export     write a restorable snapshot of this device to a file
```

| Option | Meaning |
|---|---|
| `--root <dir>` | treat `<dir>` as the harness home instead of `$DSH_HOME` / `~/.dsh` |
| `--data-root <dir>` | this plugin's data directory instead of `<harness home>/harness-sync` |
| `--workspace <dir>` | the session workspace to include (default `$DSH_WORKSPACE`, then the path `init` recorded). Without one, only the harness home is synced |
| `--profile <name>` | profile to sync (default `web`) |
| `--device <name>` | device name recorded in snapshots (default: hostname) |
| `--url` / `--user` / `--repo` / `--branch` | non-interactive inputs for `init` |
| `--force` | proceed even though the repository advanced (`push`) |
| `--dry-run` | report only, change nothing |
| `--list` / `--to` | list or choose a backup (`rollback`) |
| `--no-color` | disable colour |
| `-h, --help` / `-v, --version` | help / version |

**Exit codes**: `0` success · `1` error · `2` diverged — you must choose (pull or force-push)

**Environment**: `DSH_HOME`, `HARNESS_SYNC_HOME`, `HARNESS_SYNC_DEVICE`, `GH_TOKEN`/`GITHUB_TOKEN`, `NO_COLOR`

---

## 13. Restoring on a new machine

```bash
# 1. Install the plugin (zero build, no toolchain needed)
dsh plugin --profile web add github:<your-account>/deepseek-harness-sync

# 2. Restart dsh web
dsh web

# 3. Connect your private configuration repository
harness-sync init

# 4. Look before you leap
harness-sync status
harness-sync pull --dry-run

# 5. Apply
harness-sync pull

# 6. If the profile's bundle list changed, install and restart
cd "$DSH_HOME/profiles/web" && pnpm install
dsh web
```

> Remember: the **plugin** repository and the **configuration** repository are two different repositories.
> The first makes it run; the second brings your configuration back.

---

## 14. Development

```bash
npm test
```

90 tests, all running against a throwaway harness home in the system temp directory and a throwaway local
`git init --bare` remote. **The suite never reads or writes a real `$DSH_HOME`.** It covers:

- path-resolution precedence and whitelist rejection (traversal, absolute, drive letter, non-config paths);
- the collector's **credential-copy regression** (no collected file may share the credential store's hash);
- the credential screen (blocks, and never echoes the matched value), plus a **false-positive regression**:
  on a real machine, `'@deepseek-ai/dsh-credentials': ^0.1.0-rc.6 || …` in `pnpm-lock.yaml` blocked every
  push until package names and version ranges were recognised as non-secrets;
- deterministic snapshot serialization and rejection of malformed snapshots;
- atomic writes, traversal refusal, `absent` deletion, and no leftover temp files;
- backup rotation (keep 5) and a rollback round trip;
- the plugin contract as cordis calls it, `inject` naming only `tools`, loading without a command
  registry, argument validation, and the slash command;
- **safe reuse of a repository owned by something else**: a pre-seeded README survives byte-identical, the
  foreign `.gitignore` rules all survive, and this plugin's block is appended exactly once;
- a **two-device end-to-end drill**: A pushes → B pulls → B edits and pushes → A's push **must be refused
  (exit 2)** → A `--force` → B pulls A's content;
- the **Settings page's HTTP bridge**: a non-loopback peer gets 403, `Sec-Fetch-Site: cross-site` gets 403, a
  cross-origin or malformed `Origin` gets 403, a state change sent as GET gets 405, `status` sent as POST gets
  405, an unknown endpoint gets 404, a non-JSON body gets 400, and no response carries a credential;
- the **browser bundle**, loaded exactly as the client module system loads it
  (`window.__ModuleLoader__.load({id, factory})` → `factory(require)`): `id` equals the package name, only the one
  baseline module (`react`) is required, the exports are a mountable cordis plugin, exactly one page is registered
  on `settings.section`, a disposer comes back, and the file contains no ESM and no top-level side effects.

Layout:

```text
bin/harness-sync.js      CLI entry
lib/run.js               argument parsing + dispatch (shared by CLI and plugin)
lib/index.js             DSH host plugin entry (tools / slash command / mounts the HTTP bridge)
lib/client.js            browser half: the hand-written Settings-page bundle (no build)
lib/ui.js                terminal output
lib/host/
  api.js                 the loopback HTTP bridge and its three request checks
lib/core/
  paths.js               $DSH_HOME / data-directory resolution
  manifest.js            the whitelist and assertManaged()   ← the security boundary
  collect.js             read configuration (whitelist only)
  snapshot.js            envelope, hashing, deterministic JSON
  apply.js               atomic writes (validate everything, then write)
  backup.js              back up / rotate / restore
  guard.js               credential screen + private-repository check
  github.js              git transport: auth injection, error translation
  state.js               this plugin's config (structurally token-free)
  diff.js                line-level diff
lib/commands/            init / status / push / pull / sync / diff / rollback
test/                    core / plugin / api / client / e2e
```

---

## 15. Known limitations

- **`--force` overrides configuration content, never remote history** (by design, §8.4).
- **No background auto-sync** (deferred). Everything is an explicit command.
- **No OAuth Device Flow** (deferred), for the reason in §6.3.
- **No content merging.** Divergence asks you to choose rather than three-way-merging your
  `settings.yaml` (merging a comment-preserving YAML document is far more dangerous than asking).
- **Directory trees are add/overwrite only.** Files deleted remotely inside `.agent-presets/**` or
  `skills/**` are not deleted locally; only whitelisted **fixed files** carry the `absent` deletion
  semantics.
- **Without a token, repository privacy cannot be checked automatically** — only warned about (§2.1).
- **Backups rotate at 5 per pull.** Adjust `keepBackups` in `config.json` to change it.
- **The Settings page needs a `dsh web` restart to appear**: a new bundle changes the profile's layer stack,
  which cannot be hot-reloaded.
- **The Settings page needs the built-in web server.** Electron loads the client over `file://` and carries fetch
  over IPC; there the page renders but its buttons report that the host is unreachable instead of failing silently.
- **The browser half is hand-written, so it cannot use JSX or TypeScript.** That is a deliberate trade for a
  zero-build install that needs no toolchain on a new machine: DSH serves client bundles as classic `<script>`
  (no ESM), and the built artifact must be committed.

## 16. License

MIT
