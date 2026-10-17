# oc-go-multi-auth

> **Multi-account API key rotation for [OpenCode](https://opencode.ai) Go subscription.**

Run multiple OpenCode Go accounts side-by-side through OpenCode's own `opencode-go` provider. The plugin keeps a working account sticky across the live process and moves to another account only when the provider reports a credential, quota, or entitlement problem.

One package serves both OpenCode generations. OpenCode 1.18.29+ calls the V1 `server()` entry, which returns a rotating `fetch` for the `opencode-go` auth loader. OpenCode 2.0.28 through 2.x calls the V2 `setup()` entry, which leaves OpenCode's stock `opencode-go` provider, protocol, and transport in place and swaps the credential through public session hooks. Both share one account file, one account-selection policy, and one failure classifier.

![License](https://img.shields.io/github/license/imarshallwidjaja/oc-go-multi-auth)
![GitHub last commit](https://img.shields.io/github/last-commit/imarshallwidjaja/oc-go-multi-auth)

---

## Features

- **Multi-account failover** — On V1, the plugin replays the same request with each remaining available Go API key when credentials or quota clearly fail. On V2, it marks the failing account and lets OpenCode's own retry run the next attempt with another account.
- **Overage preference roles** — Tag a paid-overage account as `overage_fallback` so the plugin prefers primaries and leaves overage as soon as a primary is available again.
- **Live-session account stickiness** — Successful requests keep using the same account when it remains preferred. A successful replacement becomes sticky for later requests and is recorded for the next start.
- **Safe response classification** — HTTP 401/402 and clear credential signals block an account for the process. Clear quota, rate, or usage signals apply a bounded cooldown. Engine overload and unknown 429 responses are left to OpenCode without penalizing an account.
- **Quota report** — `/go-usage` and `oc-go-multi-auth usage` query `GET https://opencode.ai/zen/go/v1/usage` for every stored account. The report leads with the summed leftover percent for the 5-hour, weekly, and monthly windows across accounts whose lookup succeeded. A rate-limited window is left out of that window's sum. Each account lists remaining vs used percent. Remaining dollars are not on that endpoint today.
- **Account management** — `/go-accounts` inside OpenCode (V1 and V2) and the `oc-go-multi-auth` CLI add accounts, change roles, and remove accounts. Edits are locked, so concurrent edits from several places do not overwrite each other. On V1, OpenCode's provider connect flow also offers **Add Go Account**, which adds an account from the stock web UI of a headless server. On V2, a Go API key connected in OpenCode's own provider settings is added to the pool.
- **Persistent state** — Accounts and the last-used account survive restarts.
- **No modifications to OpenCode** — Installs as a plugin, zero risk to your existing setup.

---

## Source Setup

Clone and build the current source for development and verification:

```sh
git clone https://github.com/imarshallwidjaja/oc-go-multi-auth
cd oc-go-multi-auth
bun install
bun run build
```

You can run the account CLI from the checkout with `bun run src/cli.ts`. Do not use a raw Git package specifier as a V2 installation shortcut: OpenCode V2 installs packages with lifecycle scripts disabled, so the Git install does not run this package's `prepack` build.

## Registry Installation

Install the published [npm package](https://www.npmjs.com/package/oc-go-multi-auth) globally:

```sh
bun add --global oc-go-multi-auth
```

OpenCode V1 loads server plugins from `opencode.json` and TUI plugins from `tui.json`. Add the registry package to both global configuration files:

`~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["oc-go-multi-auth"]
}
```

`~/.config/opencode/tui.json`:

```json
{
  "plugin": ["oc-go-multi-auth"]
}
```

OpenCode V2 uses the plural `plugins` key in `opencode.json`, and loads the package's `./tui` entry for the terminal UI automatically:

```json
{
  "plugins": ["oc-go-multi-auth"]
}
```

The global package install exposes the `oc-go-multi-auth` account-management CLI. OpenCode resolves the same registry package for the configured plugin. Restart OpenCode after installing or updating it.

Version 0.1.x published a `./v2/provider` export that replaced the OpenCode 2.0.2 provider package. That export is retired: OpenCode 2 now keeps its stock `opencode-go` provider, and the plugin works through session hooks. Remove any configuration that references `oc-go-multi-auth/v2/provider`.

**Prerequisites:**
- [OpenCode](https://opencode.ai) 1.18.29 through 1.x, or 2.0.28 through 2.x. OpenCode 2 releases before 2.0.28 stop at plugin setup with an "unsupported host" error.
- [Bun](https://bun.sh) 1.x on your `PATH`: the `oc-go-multi-auth` CLI starts with `#!/usr/bin/env bun`, so it needs Bun even when installed with npm. Bun is also required for local development. The package is verified with Bun 1.4.2.
- One or more Go API keys from [opencode.ai/auth](https://opencode.ai/auth)

---

## Quick Start

### 1. Get your Go API keys

Open [opencode.ai/auth](https://opencode.ai/auth) in your browser and generate one or more Go subscription API keys. Copy each key to your clipboard.

### 2. Add accounts to the pool

Inside OpenCode (V1 or V2), run `/go-accounts`, choose **Add account**, paste the key, give it an optional label, and pick a role: `primary` (the default) or `overage_fallback` for a paid-overage safety net. From a terminal, the CLI does the same:

```sh
oc-go-multi-auth add --key <key> --label "Work"
```

From a source checkout, run `bun run src/cli.ts add --key <key> --label "Work"` instead.

On OpenCode 1 you can also add accounts through OpenCode's own provider connect flow, which works from the stock web UI of a headless server. Choose **Add Go Account** for OpenCode Go in the web UI's provider list, in the TUI's `/connect`, or with `opencode auth login -p opencode-go -m "Add Go Account"`. It asks for the key, a label (required here), and a role, adds the account to the pool, and connects OpenCode Go with that key, replacing the key OpenCode had stored for `opencode-go`. Once OpenCode Go is connected, reach it again through **Show more providers** to add the next account. See [Add Go Account](./docs/account-management.md#add-go-account-opencode-1-provider-connect).

On OpenCode 2 you can connect the key in the server's web UI instead: **Settings** → **Providers** → **Go Accounts** → **Add account** → **Use API key**. The plugin adds each key connected this way to the pool as a `primary` account, unless the pool already holds it. Keys OpenCode had stored before the server started are not added, and removing an account from the pool never brings it back from OpenCode's credentials. See [Keys connected in OpenCode 2's provider settings](./docs/account-management.md#keys-connected-in-opencode-2s-provider-settings).

Repeat for each Go subscription you own.

### 3. Restart OpenCode

The running process keeps the account list it loaded at startup, so restart OpenCode after adding accounts or changing roles, including keys the V2 plugin added from OpenCode's provider settings. The exception is **Add Go Account** completed in the web UI or the TUI: OpenCode reloads its server instance after the connection, which reloads the pool. After `opencode auth login` with **Add Go Account**, restart any OpenCode server that is already running. When OpenCode has no `opencode-go` key yet, the first account added through `/go-accounts` also connects OpenCode Go with that key; on V2 the plugin does the same at startup. A stored key stays as it is. On V1 a connection from an environment variable or from configuration may sit on top of a stored key that OpenCode's public API cannot show, so `/go-accounts` asks first: **Connect pool account** stores the new key (replacing any stored OpenCode Go key), **Keep current connection** leaves the connection unchanged, and rotation then needs a stored key and a restart. On V2 nothing is connected when OpenCode has rebound `opencode-go` to another integration such as a Console one, and the pool leaves that provider alone. The V2 pool also writes a key only onto requests that go to the base URL OpenCode has configured for Go (the provider's, or the selected model's or variant's); anything else keeps the host's own credential and is logged as `rotation inactive`.

---

## Account Management

| Where | Command | Purpose |
|---|---|---|
| OpenCode | `/go-accounts` | Add an account, change a role, or remove an account |
| OpenCode | `/go-usage` | Quota report for every stored account |
| OpenCode 1 provider connect | **Add Go Account** | Add an account and connect OpenCode Go with its key |
| OpenCode 2 provider settings | **Go Accounts** → **Add account** → **Use API key** | Connect a key in OpenCode; the plugin adds it to the pool |
| Terminal | `oc-go-multi-auth list` | List configured accounts and roles |
| Terminal | `oc-go-multi-auth add --key <key> [--label …] [--role …]` | Add an account |
| Terminal | `oc-go-multi-auth set-role <number> <primary\|overage_fallback>` | Set an account's preference role |
| Terminal | `oc-go-multi-auth remove <number>` | Remove an account by its 1-based list number |
| Terminal | `oc-go-multi-auth status` | Show account counts by role and the last-used account |
| Terminal | `oc-go-multi-auth usage` | Same report as `/go-usage` |

OpenCode's own provider connection stores a single key for the stock provider. On OpenCode 1, the stock **Go API key** method (the first method for OpenCode Go in `opencode auth login` or OpenCode's provider list) stores only that key and adds nothing to the pool, and **Add Go Account** stores the key in OpenCode the same way and also adds it to the pool. On OpenCode 2, a key connected with **Use API key** while the server runs is also added to the pool. The stored key is separate from the pool either way: removing a pool account does not disconnect or delete a key stored in OpenCode, and switching or removing OpenCode's credentials does not change the pool.

`/go-usage` and `oc-go-multi-auth usage` call `GET https://opencode.ai/zen/go/v1/usage` with each enabled account's API key. The report leads with the summed leftover percent for the 5-hour, weekly, and monthly windows across accounts whose lookup succeeded. A rate-limited window is left out of that window's sum. The endpoint returns percent-used for those windows. It does not currently return remaining dollars. Disabled accounts are listed as not queried. Per-account HTTP or network failures stay on that account; the rest of the report still prints. On the V1 screen, that aggregate is the first row.

Both commands come from the package's `./tui` entry. On V2 they reach the server through the plugin's RPC, so they also work against a remote OpenCode server that has the plugin configured. The terminal that shows them must load the package too: a client connecting with `opencode --server <url>` reads its own `~/.config/opencode/cli.json`, and with an empty client configuration the commands do not appear. Add the package there (the server keeps it in `opencode.json`):

`~/.config/opencode/cli.json` on the client machine:

```json
{
  "plugins": ["oc-go-multi-auth"]
}
```

OpenCode V1 loads them from `tui.json` and edits the local account file directly. To add accounts to a remote V1 server, use **Add Go Account** in the server's web UI or in a TUI attached to it; that runs on the server and writes the server's account file. For role changes and removal, run the CLI on that server. When using a source checkout instead of the registry package, configure the built files with absolute paths (relative source-checkout paths are not supported):

`~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-go-multi-auth/dist/index.js"]
}
```

`~/.config/opencode/tui.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-go-multi-auth/dist/tui.js"]
}
```

Select `/go-usage` or `/go-accounts` from slash completion or the command palette. Use Up/Down, PageUp/PageDown, Home/End, and Enter to browse account details; Escape closes the report. If autocomplete is dismissed or unavailable, submitting `/go-usage` sends the literal text as an ordinary prompt even when the TUI plugin is loaded; the V1 server command API cannot suppress that model turn. The same fallback applies if the TUI entrypoint is disabled or fails to load.

On V1, OpenCode runs the plugin's loader only when `opencode-go` has a stored key. Add the first account through **Add Go Account** (which always stores its key), through `/go-accounts` (which stores the key when none is stored; a connection from the environment or configuration asks you to choose **Connect pool account** or **Keep current connection**), or connect any Go key with OpenCode's provider flow, then restart. The standalone CLI cannot reach OpenCode, so it never connects a key. On V2, setup connects the first eligible pool key when `opencode-go` has no connection and is still bound to the Go integration.

---

## How Rotation Works

1. **Successful requests stay sticky** — The process reuses one account and records a successful replacement for the next startup.
2. **Clear credential failures move to another account** — Invalid credentials are blocked for the process; quota, rate, and usage failures cool down temporarily and become eligible automatically. V1 replays the request inside its fetch. V2 asks OpenCode's retry loop for an immediate retry, which then uses the next account; OpenCode's own attempt limit still applies.
3. **Provider responses stay authoritative** — Overload and unknown 429 responses do not rotate. Every attempt reaches the provider and returns a real response rather than a synthetic exhaustion error.

See [docs/quota-rotation.md](./docs/quota-rotation.md) for details.

---

## Storage

Accounts and rotation state live in `~/.config/opencode/`:

| File | Written by | Purpose |
|---|---|---|
| `opencode-go-accounts.json` | `/go-accounts`, the CLI, **Add Go Account** (V1), the key import (V2) | Stored API keys, labels, roles, enabled state |
| `opencode-go-accounts.json.lock` | edits, while they run | Serializes edits; removed when the edit finishes |
| `opencode-go-rotation.json` | the running plugin | Last-used account, by index and a non-secret account fingerprint |

Both JSON files use `0o600` permissions and are written through a unique temporary file and a rename. If the account file cannot be parsed, edits stop with an error and leave it in place (a `.bak.<timestamp>` copy is saved); the running plugin and listings treat it as empty.

---

## Development

```sh
git clone https://github.com/imarshallwidjaja/oc-go-multi-auth
cd oc-go-multi-auth
bun install
bun test       # unit tests
bun run build  # builds declarations and the V1/V2 package entrypoints
bun run typecheck  # tsc --noEmit
node scripts/verify-package.mjs  # build, pack, and smoke-test the installed tarball
```

Maintainers publishing to npm: see [docs/publishing.md](./docs/publishing.md).

---

## Architecture

```
index.ts ── V1 server(): auth loader ──▶ runtime.ts ──▶ fetch.ts (replay loop)
         └─ V2 setup() ──▶ v2.ts ──▶ v2-transport.ts (session hooks)
                                  ├─▶ v2-import.ts (keys connected in OpenCode)
                                  └─▶ rpc.ts (account RPC contract)
tui.ts ── /go-accounts, /go-usage ──▶ tui-flows.ts

shared: pool.ts (selection, cooldowns, settlement)
        classification.ts (failure classifier)
        accounts.ts, storage.ts (locked account edits, rotation hint)
        usage.ts (quota report)
```

See [docs/architecture.md](./docs/architecture.md) for the full breakdown.

---

## License

MIT. See [LICENSE](./LICENSE).
