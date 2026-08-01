# Architecture

How `oc-go-multi-auth` is built, how the modules interact, and the data flow.

---

## Module Overview

```
src/
├── types.ts       # Shared type definitions
├── storage.ts     # Atomic file I/O for accounts & rotation state
├── rotate.ts      # Round-robin account selection logic
├── fetch.ts       # Auth header injection + credential failover interceptor
├── index.ts       # Plugin entry point (loader + Add Go Account method)
├── cli.ts         # List, remove, and inspect stored accounts
└── __tests__/     # automated tests
    ├── storage.test.ts
    ├── rotate.test.ts
    ├── fetch.test.ts
    └── plugin.test.ts
```

---

## Data Flow

### Session Start

```
1. OpenCode starts
         │
2. Auth Store Check ─── empty? ──▶ Skip plugin loader
         │
      has value
         │
3. Plugin loader() invoked
         │
4. loadAccounts() ──────────▶ reads ~/.config/opencode/opencode-go-accounts.json
   loadRotationState() ────▶ reads ~/.config/opencode/opencode-go-rotation.json
         │
5. hasAccounts() check ────▶ if no enabled accounts, return {} (skip)
         │
      has accounts
         │
6. selectAccount(accounts, lastUsedIndex)
   │  ├── start from (lastIndex + 1) % total
   │  ├── skip disabled accounts
   │  └── return { account, index }
   │
7. Persist rotation state
   │  ├── saveAccounts({ ...rotationIndex: index })
   │  └── saveRotationState({ lastUsedIndex: index })
   │
8. Sync key to auth store
   │  └── authClient.auth.set({ body: { type: "api", key } })
   │
9. Create rotating fetch
   │  └── createRotatingFetch(accounts, lastUsedIndex)
   │
10. Return { apiKey, fetch } to OpenCode
```

### Request Flow

```
OpenCode API call
         │
         ▼
rotatingFetch(input, init)
         │
         ├── prefer available primary over sticky overage_fallback
         ├── headers.set("Authorization", "Bearer <activeKey>")
         ├── await globalThis.fetch(input, headers)
         │
         ▼
    Response classification?
         │
     success ──▶ return response ✓
     auth failure ──▶ block account for process
     quota/rate/usage failure ──▶ set bounded cooldown
              │
              ▼
              select next preferred enabled, available, unattempted account
              (primaries before overage_fallback)
              │
        no candidate? ──▶ return last upstream response
              │
          has candidate
              │
              ▼
              retry request with new auth header

     overload/unknown 429 ──▶ return original response without penalty

     all candidates unavailable at start ──▶ probe sticky enabled account once
```

### Account Management Flow

```
User selects "Add Go Account"
         │
         ├── prompts: apiKey, label, role
         │
         ▼
authorize({ apiKey, label, role })
    │
    ├── loadAccounts() from disk
    ├── append new account (role defaults to primary)
    ├── saveAccounts() to disk
    ├── authClient.auth.set() to prime store
    └── return success

User selects "Set Go Account Role"
         │
         ├── prompts: account number, role
         │
         ▼
authorize({ account, role })
    │
    ├── loadAccounts() from disk
    ├── update account.role
    ├── saveAccounts() to disk
    └── return success

User runs oc-go-multi-auth list/add/set-role/remove/status
         │
         ▼
cli.ts
    ├── loadAccounts() from disk
    ├── list: print labels, enabled state, role, and persisted current marker
    ├── set-role: update primary / overage_fallback preference
    ├── remove: splice the selected 1-based account number and save
    └── status: print account counts by role and persisted rotation state
```

---

## Module Details

### `types.ts` — Shared Types

```ts
type AccountRole = "primary" | "overage_fallback"

interface GoAccount {
  apiKey: string
  label?: string
  addedAt: number        // Unix ms timestamp
  enabled: boolean       // false = skipped during rotation
  role: AccountRole      // preference tier; missing values normalize to primary on load
}

interface AccountsFile {
  version: 1             // schema version for forward compat
  accounts: GoAccount[]
  rotationIndex: number  // which account is currently active (0-based)
}

interface RotationState {
  lastUsedIndex: number  // persisted across sessions (-1 = none)
}
```

### `storage.ts` — File I/O

Uses `process.env.HOME` to locate the config directory (`~/.config/opencode/`).

**Atomic write pattern:**

```ts
function atomicWrite(path: string, data: string) {
  const tmp = path + ".tmp." + process.pid  // same filesystem = no EXDEV
  writeFileSync(tmp, data, "utf-8")
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)  // atomic on POSIX
}
```

**Corrupt file recovery:** If JSON parsing fails, the corrupt file is copied to `path.bak.<timestamp>` and a fresh default is returned. Previous state is never silently lost.

### `rotate.ts` — Selection Logic

```ts
function selectAccount(
  accounts: GoAccount[],
  lastIndex: number        // -1 means "start from 0"
): { account: GoAccount; index: number }
```

The selection loop:

```
for i = 1 to total:
    candidate = (lastIndex + i) % total
    if accounts[candidate].enabled:
        return accounts[candidate]
throw NoEnabledAccounts
```

This guarantees every enabled account gets a turn before any account repeats.

### `fetch.ts` — HTTP Interceptor

Wraps `globalThis.fetch` (or a provided `baseFetch`) to:

1. **Strip** any `Authorization` header from the incoming request.
2. **Set** `Authorization: Bearer <activeAccountKey>`.
3. **Clone and forward** the request so method, signal, headers, and body can be replayed safely.
4. **On auth failure:** HTTP 401/402 or a clear invalid-key, authentication, or model-entitlement signal blocks the credential for the process and rotates.
5. **On quota failure:** A clear quota, rate, or usage signal starts a 60-second cooldown and rotates. Valid `Retry-After` seconds or HTTP dates override that duration up to 10 minutes.
6. **On ambiguous non-success:** Inspect a clone for at most 64 KiB and one second. Plain text uses terminal phrases; JSON uses allowlisted top-level or nested `error` code/type discriminators and selected message fields.
7. **On overload or unknown 429:** Return the original response without rotating or penalizing the account. Explicit overload wins over `Retry-After`, which is not a standalone quota signal.
8. **On success:** Accept the state mutation only when the attempt's account generation still matches. Clear a cooldown but never an auth block. A successful failover replacement updates the persisted rotation index only if no newer request has succeeded.
9. **On unavailable candidates:** Probe the sticky enabled credential once. Return that response, or the last real response after a fully attempted traversal; never create a synthetic exhaustion response.

Traversal state is request-scoped, so one logical request attempts each enabled, available credential at most once. Auth blocks and cooldown deadlines are process-local. Per-account availability generations reject stale success and penalty mutations. Global request-success ordering prevents an older request from changing or persisting stickiness after a newer request succeeds, without serializing requests.

The interceptor accepts a `baseFetch` parameter for testability:

```ts
const { fetch } = createRotatingFetch(accounts, lastIndex, mockFetch)
```

### `index.ts` — Plugin Entry

The plugin is an async function matching OpenCode's `Plugin` type:

```ts
const plugin: Plugin = async ({ client }) => {
  return {
    auth: {
      provider: "opencode-go",
      loader: async (getAuth) => { /* ... */ },
      methods: [ /* auth methods */ ],
    },
  }
}
```

The `loader` and **Add Go Account** authorize function both use `authClient.auth.set()` to sync the current key to OpenCode's auth store. This is essential because OpenCode checks the auth store before calling the loader. Account listing, removal, and status are implemented separately in `cli.ts` and are not OpenCode auth methods.

---

## Storage Format

### `~/.config/opencode/opencode-go-accounts.json`

```json
{
  "version": 1,
  "accounts": [
    {
      "apiKey": "go_xxxxxxxxxxxx",
      "label": "Work Account",
      "addedAt": 1745800000000,
      "enabled": true,
      "role": "primary"
    },
    {
      "apiKey": "go_yyyyyyyyyyyy",
      "label": "Overage Backup",
      "addedAt": 1745800100000,
      "enabled": true,
      "role": "overage_fallback"
    }
  ],
  "rotationIndex": 0
}
```

### `~/.config/opencode/opencode-go-rotation.json`

```json
{
  "lastUsedIndex": 0
}
```

Both files are created with `0o600` permissions (readable only by the owner) since they contain sensitive API keys.

---

## Plugin System Integration

OpenCode loads plugins via the `@opencode-ai/plugin` package. The plugin exports a default function:

```ts
export default plugin
// type: (input: PluginInput) => Promise<Hooks>
```

The `PluginInput` provides:
- `client` — OpenCode's internal client (accessed as `any` for `auth.set()` / `auth.get()`)
- `project`, `directory`, `worktree`, `serverUrl`, `experimental_workspace`, `$` — standard context

The returned `Hooks.auth` object has:
- `provider: "opencode-go"` — must match the target provider ID and stored auth ID
- `loader(getAuth) -> { apiKey, fetch }` — called at session start
- `methods: AuthMethod[]` — available to the user via command palette

The single auth method uses `type: "api"` for credential-based auth (**Add Go Account**). The `oc-go-multi-auth` CLI manages existing account records outside OpenCode's auth-method interface.

---

## Security Considerations

- **API keys are stored in plaintext** on disk (`~/.config/opencode/`). Only the owner can read them (`0o600`).
- **Keys are held in memory** for the duration of the session.
- **No independent network calls** are made by the plugin — it only intercepts and may safely replay OpenCode's existing `opencode-go` API calls.
- **No external dependencies** other than `@opencode-ai/plugin` for type definitions.
