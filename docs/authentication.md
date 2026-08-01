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

### Via OpenCode Auth Settings

1. Open OpenCode.
2. Go to **Settings → Auth** (or open the command palette and type "Auth").
3. Find the "Go Multi-Auth" provider section.
4. Click **Add Go Account**.
5. Paste your Go API key when prompted.
6. Optionally enter a label (e.g. "Work", "Personal") to identify the account later.
7. Confirm — you'll see a success response.

### What Happens Behind the Scenes

When you submit the API key:

1. The plugin reads the current accounts from `~/.config/opencode/opencode-go-accounts.json`.
2. It appends the new account with `enabled: true` and the current timestamp.
3. If this is the **first account** ever added, it sets `rotationIndex: 0` (marking it active).
4. It writes the updated accounts file atomically (tmp file + rename).
5. It **immediately syncs** the new key to OpenCode's internal auth store via `authClient.auth.set()` — this is critical because OpenCode only activates the plugin's `loader()` when the auth store has a value for the `"opencode-go"` provider.

> **Important:** The first account you add is special — it "primes" OpenCode's auth store so the plugin's loader actually fires on subsequent sessions. If you remove all accounts, the loader stops running until you add one again.

---

## The Auth Provider Flow

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

This is the single most important detail of the plugin: **the loader function only runs when OpenCode's auth store has a value for the `"opencode-go"` provider**. `opencode` and `opencode-go` are separate provider endpoints, so the hook and stored auth ID must match `opencode-go` exactly.

The code looks like:

```ts
// Inside OpenCode's provider.ts (simplified)
for (const hook of authHooks) {
  const auth = await authClient.auth.get({ path: { id: "opencode-go" } })
  if (!auth) continue  // ← skips the plugin entirely
  // ... calls plugin loader()
}
```

That's why `Add Go Account` calls `authClient.auth.set()` — it ensures the gate stays open. The `loader()` then calls `auth.set()` again with the **selected** account's key, keeping the gate open for the next session.

---

## How OpenCode Gets the API Key

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

---

## Troubleshooting

**"No Go accounts configured"**
→ You haven't added any accounts yet. Run `Add Go Account` from the command palette.

**OpenCode shows a different auth provider**
→ The plugin only activates for the `"opencode-go"` provider. If OpenCode is set to `opencode` or another provider, the plugin's loader won't run.

**Auth method doesn't appear in the palette**
→ Make sure the plugin is installed globally: `opencode plugin list` should show it.

**Loader doesn't fire after adding first account**
→ After adding your first account via `Add Go Account`, the key is synced to the auth store. Restart OpenCode (quit and reopen) for the loader to activate on the new session.
