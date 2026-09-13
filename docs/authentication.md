# Authentication

How `oc-go-multi-auth` authenticates with OpenCode's Go subscription tier.

---

## Overview

OpenCode's Go subscription uses **API key authentication**. Each Go account comes with a unique API key that you generate from the OpenCode dashboard.

This plugin stores multiple Go API keys and presents one of them to OpenCode's `opencode-go` provider at session start. A working key remains sticky until a credential-scoped failure requires failover.

---

## Getting Go API Keys

1. Open [opencode.ai/auth](https://opencode.ai/auth) in your browser.
2. Sign in with your Go subscription account.
3. Click **Generate API Key** (or the equivalent button).
4. Copy the displayed API key — it looks like `go_xxxxxxxxxxxx`.
5. Repeat for each Go subscription you want to use.

Each key is tied to a specific Go subscription and its associated quota.

---

## Adding an Account

### Via OpenCode V1 Auth Settings

1. Open OpenCode.
2. Go to **Settings → Auth** (or open the command palette and type "Auth").
3. Find the "Go Multi-Auth" provider section.
4. Click **Add Go Account**.
5. Paste your Go API key when prompted.
6. Optionally enter a label (e.g. "Work", "Personal") to identify the account later.
7. Confirm — you'll see a success response.

### Via CLI on V1 or V2

```sh
oc-go-multi-auth add --key <key> --label "Work" --role primary
```

Restart OpenCode after adding an account. V2 runs plugin setup at startup, registers the `opencode-go` key method, and seeds an integration connection when one does not already exist.

### What Happens Behind the Scenes on V1

When you submit the API key:

1. The plugin reads the current accounts from `~/.config/opencode/opencode-go-accounts.json`.
2. It appends the new account with `enabled: true` and the current timestamp.
3. If this is the **first account** ever added, it sets `rotationIndex: 0` (marking it active).
4. It writes the updated accounts file atomically (tmp file + rename).
5. It **immediately syncs** the new key to OpenCode's internal auth store via `authClient.auth.set()` — this is critical because OpenCode only activates the plugin's `loader()` when the auth store has a value for the `"opencode-go"` provider.

> **Important:** The first account you add is special: it primes OpenCode's auth store so the plugin's loader can run on subsequent sessions. If you remove all accounts, the loader stops running until you add one again.

---

## The V1 Auth Provider Flow

OpenCode's plugin system uses this lifecycle:

```
Session Start
  │
  ▼
Auth Store Check ─── Empty ──▶ Skip loader, use default auth
  │
  Non-empty
  │
  ▼
Plugin loader() called
  │
  ▼
  │
  ├── loadAccounts() from disk
  ├── pick next account (round-robin)
  ├── sync selected key to auth store
  ├── create rotating fetch interceptor
  │
  ▼
Return { apiKey, fetch } to OpenCode
  │
  ▼
OpenCode uses returned fetch for all API calls
```

### The Auth Store Gate

On V1, the loader function only runs when OpenCode's auth store has a value for the `"opencode-go"` provider. `opencode` and `opencode-go` are separate provider endpoints, so the hook and stored auth ID must match `opencode-go` exactly.

That's why `Add Go Account` calls the V1 SDK's `authClient.auth.set()` endpoint: it ensures the provider has stored credentials. The `loader()` calls the same endpoint with the selected account's key, keeping the provider active for the next session. Both calls inspect the SDK result and fail explicitly when OpenCode rejects the write.

## The V2 Setup Flow

V2 calls the plugin's `setup()` entrypoint directly. Setup always registers an `opencode-go` key method. When an account is enabled, it uses `ctx.catalog.transform` to replace supported OpenAI-compatible, OpenAI, and Anthropic provider/model packages with the package's V2 native entrypoint. The transform applies OpenCode 2.0.2's AI SDK-to-native settings normalization and records each original package. Unsupported packages stay with the host. If no account is enabled, setup leaves the catalog unchanged; add an account with the CLI and restart OpenCode. Repeated setup on the same context replaces the prior registrations instead of stacking them. V2 does not call the V1 `server()` entrypoint or expose the V1 auth methods.

---

## How OpenCode Gets the API Key on V1

The `loader()` returns:

```ts
return {
  apiKey: "",
  async fetch(input, init) {
    return rotatingFetch(input, init)  // wraps with auth header
  },
}
```

OpenCode uses the returned `fetch` function as a drop-in replacement for `globalThis.fetch`. Every `opencode-go` API call goes through this interceptor, which attaches the `Authorization: Bearer <key>` header and safely replays cloneable requests when a credential-scoped response triggers failover.

The `apiKey` field is deliberately left empty because OpenCode uses the returned `fetch` rather than reading `apiKey` directly (at least for the Go provider).

V2 adapts the same rotating fetch state machine to the host-supplied native HTTP handler. Every retry re-enters the supplied handler and middleware with a fresh request body. It replaces both supported protocol credential headers, then applies `Authorization: Bearer` for OpenAI-compatible/OpenAI or `x-api-key` for Anthropic. The advisory usage request always uses bearer authentication to `opencode.ai`. The native provider retains endpoint construction, request serialization, response framing, and stream parsing. Setup also seeds an enabled key as an `opencode-go` integration connection when needed. Rotation remains registered if this optional connection seed fails; the failure is written to the plugin log.

---

## Troubleshooting

**"No Go accounts configured"**
→ You haven't added any accounts yet. Use `oc-go-multi-auth add`, or run **Add Go Account** from OpenCode V1's auth settings.

**OpenCode shows a different auth provider**
→ The plugin only activates for the `"opencode-go"` provider. If OpenCode is set to `opencode` or another provider, the plugin's loader won't run.

**Auth method doesn't appear in the palette**
→ V2 does not expose the V1 auth methods; use the CLI. On V1, make sure the plugin is installed globally: `opencode plugin list` should show it.

**Loader doesn't fire after adding first account**
→ This applies to V1. Add the first account through **Add Go Account** so the key is synced to the auth store, then restart OpenCode. On V2, add the account with the CLI and restart so `setup()` can connect it.
