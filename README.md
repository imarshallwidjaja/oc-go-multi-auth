# oc-go-multi-auth

> **Multi-account API key rotation for [OpenCode](https://opencode.ai) Go subscription.**

Run multiple OpenCode Go accounts side-by-side through OpenCode's `opencode-go` provider. The plugin keeps a working account sticky across the live process and fails over only when the provider reports a credential, quota, or entitlement problem.

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

## Installation

```sh
opencode plugin github:imarshallwidjaja/oc-go-multi-auth --global
```

This installs the plugin globally so every OpenCode session uses it.

**Prerequisites:**
- [OpenCode](https://opencode.ai) 1.x (Go subscription)
- [Bun](https://bun.sh) 1.x (for local development)
- One or more Go API keys from [opencode.ai/auth](https://opencode.ai/auth)

---

## Quick Start

### 1. Get your Go API keys

Open [opencode.ai/auth](https://opencode.ai/auth) in your browser and generate one or more Go subscription API keys. Copy each key to your clipboard.

### 2. Add an account to the plugin

In OpenCode, open the auth settings and run the **Add Go Account** method:

```
OpenCode Settings → Auth → Add Go Account
```

Paste your Go API key when prompted. Optionally give it a label (e.g. "Work", "Personal", "Account 2") and a role (`primary` by default, or `overage_fallback` for a paid-overage safety net).

Repeat for each Go subscription you own. Tag the overage-enabled account with `oc-go-multi-auth set-role <n> overage_fallback` so the plugin leaves it as soon as another account is available again.

### 3. Start using OpenCode

That's it. The plugin automatically picks an account on every session start and signs all `opencode-go` provider requests with its API key. OpenCode will show `opencode-go` as the active auth provider.

---

## Account Management

OpenCode exposes auth methods for this plugin:

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

Run **Add Go Account** from OpenCode's auth settings so the first key also primes the `opencode-go` auth store.

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
bun test       # tests across 4 modules
bun run build  # bundles to dist/index.js
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
