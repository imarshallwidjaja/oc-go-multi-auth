# oc-go-multi-auth

> **Multi-account API key rotation for [OpenCode](https://opencode.ai) Go subscription.**

Run multiple OpenCode Go accounts side-by-side through OpenCode's `opencode-go` provider. The plugin keeps a working account sticky across the live process and fails over only when the provider reports a credential, quota, or entitlement problem.

The package source contains separate OpenCode V1 and V2 adapters. OpenCode V1 1.18.29+ calls the V1 `server()` implementation; OpenCode V2 2.0.2 through 2.0.x calls the V2 `id`/`setup()` implementation. They share account storage and rotation internals, but each adapter uses its own plugin API.

![License](https://img.shields.io/github/license/imarshallwidjaja/oc-go-multi-auth)
![GitHub last commit](https://img.shields.io/github/last-commit/imarshallwidjaja/oc-go-multi-auth)

---

## Features

- **Multi-account failover** — Retry the same logical request with each remaining available Go API key when credentials or quota clearly fail.
- **Overage preference roles** — Tag a paid-overage account as `overage_fallback` so the plugin prefers primaries and demotes sticky off overage as soon as a primary is available again.
- **Live-session account stickiness** — Successful requests keep using the same account when it remains preferred. A successful replacement becomes sticky for later requests and is persisted as the rotation position.
- **Safe response classification** — HTTP 401/402 and clear credential signals block an account for the process. Clear quota, rate, or usage signals apply a bounded cooldown. Engine overload and unknown 429 responses are returned unchanged without rotating or penalizing an account.
- **CLI account management** — Add, list, set role, remove, and inspect accounts from the terminal.
- **Persistent state** — Accounts and rotation position survive restarts.
- **No modifications to OpenCode** — Installs as a plugin, zero risk to your existing setup.

---

## Source Setup

`oc-go-multi-auth` is not published to npm yet. Clone and build the current source for development and verification:

```sh
git clone https://github.com/imarshallwidjaja/oc-go-multi-auth
cd oc-go-multi-auth
bun install
bun run build
```

You can run the account CLI from the checkout with `bun run src/cli.ts`. Do not use a raw Git package specifier as a V2 installation shortcut: OpenCode V2 installs packages with lifecycle scripts disabled, so the Git install does not run this package's `prepack` build.

## Registry Installation

After the package is published, install it globally:

```sh
bun add --global oc-go-multi-auth
```

Add the registry package name to your OpenCode configuration. V1 uses the singular `plugin` key:

```json
{
  "plugin": ["oc-go-multi-auth"]
}
```

V2 uses the plural `plugins` key:

```json
{
  "plugins": ["oc-go-multi-auth"]
}
```

The global package install exposes the `oc-go-multi-auth` account-management CLI. OpenCode resolves the same registry package for the configured plugin. Restart OpenCode after installing or updating it.

**Prerequisites:**
- [OpenCode](https://opencode.ai) 1.18.29 through 1.x, or 2.0.2 through 2.0.x (V2.0.0, V2.0.1, and V2.1+ are not supported)
- [Bun](https://bun.sh) 1.x (for local development)
- One or more Go API keys from [opencode.ai/auth](https://opencode.ai/auth)

---

## Quick Start

### 1. Get your Go API keys

Open [opencode.ai/auth](https://opencode.ai/auth) in your browser and generate one or more Go subscription API keys. Copy each key to your clipboard.

### 2. Add an account to the plugin

On OpenCode V1 1.18.29+, open the auth settings and run the **Add Go Account** method:

```text
OpenCode Settings -> Auth -> Add Go Account
```

On OpenCode V2, add the account with the CLI after a registry install:

```sh
oc-go-multi-auth add --key <key> --label "Work"
```

From a source checkout, run `bun run src/cli.ts add --key <key> --label "Work"` instead.

Optionally give the account a label and a role (`primary` by default, or `overage_fallback` for a paid-overage safety net).

Repeat for each Go subscription you own. Tag the overage-enabled account with `oc-go-multi-auth set-role <n> overage_fallback` so the plugin leaves it as soon as another account is available again.

### 3. Start using OpenCode

That's it. The plugin picks an account when it loads and signs all `opencode-go` provider requests with its API key. OpenCode will show `opencode-go` as the active auth provider.

---

## Account Management

OpenCode V1 exposes auth methods for this plugin:

| Type | Label | Purpose |
|---|---|---|
| `api` | **Add Go Account** | Add a new Go API key to the rotation pool |
| `api` | **Set Go Account Role** | Change an existing account's `primary` / `overage_fallback` role |

Use the CLI for account management and status:

| Command | Purpose |
|---|---|
| `oc-go-multi-auth list` | List configured accounts and roles |
| `oc-go-multi-auth add --key <key> [--label …] [--role …]` | Add an account from the CLI |
| `oc-go-multi-auth set-role <number> <primary\|overage_fallback>` | Set an account's preference role |
| `oc-go-multi-auth remove <number>` | Remove an account by its 1-based list number |
| `oc-go-multi-auth status` | Show account counts by role and persisted rotation state |

On V1, run **Add Go Account** from OpenCode's auth settings so the first key also primes the `opencode-go` auth store. On V2, use the CLI and restart OpenCode after adding the first account. V2 setup leaves the catalog unchanged when no account is enabled. On restart, it redirects supported OpenAI-compatible, OpenAI, and Anthropic catalog packages to the bundled native transport and seeds an integration connection when none exists.

---

## How Rotation Works

1. **Successful requests stay sticky** — The process reuses one account and persists a successful replacement for the next startup.
2. **Clear credential failures trigger bounded failover** — Invalid credentials are blocked for the process; quota, rate, and usage failures cool down temporarily and become eligible automatically.
3. **Provider responses stay authoritative** — Overload and unknown 429 responses do not rotate. An all-cooling request probes the sticky account once, and failed traversal returns a real upstream response rather than a synthetic exhaustion error.

See [docs/quota-rotation.md](./docs/quota-rotation.md) for details.

---

## Storage

Accounts and rotation state live in `~/.config/opencode/`:

| File | Purpose |
|---|---|
| `opencode-go-accounts.json` | Stored API keys, labels, enabled/disabled state |
| `opencode-go-rotation.json` | Last used account index (for round-robin) |

Both files use `0o600` permissions. The accounts file is written atomically (tmp + rename). If the file becomes corrupt, a `.bak.<timestamp>` backup is created automatically.

---

## Development

```sh
git clone https://github.com/imarshallwidjaja/oc-go-multi-auth
cd oc-go-multi-auth
bun install
bun test       # tests across 7 modules
bun run build  # builds declarations and the V1/V2 package entrypoints
bun run typecheck  # tsc --noEmit
```

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────┐
│   index.ts  │────▶│   storage.ts │────▶│  Disk    │
│  (Plugin)   │     │  (Accounts)  │     │ (JSON)   │
└──────┬──────┘     └──────────────┘     └──────────┘
       │
       ├──▶ rotate.ts     ── round-robin selection
       ├──▶ fetch.ts      ── auth header injection + credential failover
       └──▶ types.ts      ── shared type definitions
```

See [docs/architecture.md](./docs/architecture.md) for the full breakdown.

---

## License

MIT
