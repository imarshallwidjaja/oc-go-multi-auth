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
├── runtime.ts     # Shared rotation initialization and sticky-state persistence
├── index.ts       # V1 server and V2 catalog/integration setup entry point
├── v2-provider.ts # V2 native provider transport adapter
├── cli.ts         # List, remove, and inspect stored accounts
└── __tests__/     # automated tests
    ├── storage.test.ts
    ├── rotate.test.ts
    ├── fetch.test.ts
    ├── cli.test.ts
    ├── plugin.test.ts
    └── v2-provider.test.ts
```

---

## Data Flow

### Session Start on V1

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

### Session Start on V2

V2 calls `setup()` directly. Setup first registers an `opencode-go` key method through `ctx.integration.transform`. When an account is enabled, it registers `ctx.catalog.transform`, normalizes the three supported AI SDK packages using the OpenCode 2.0.2 mapping contract, records their original provider/model packages, and redirects them to `oc-go-multi-auth/v2/provider`. Unsupported provider and model packages are left unchanged. A model package takes precedence over its provider package.

The V2 provider module delegates construction to the recorded native `@opencode/ai` provider and replaces only its HTTP middleware. OpenAI-compatible chat, OpenAI responses, and Anthropic messages overrides are preserved. The catalog transform never routes an unsupported package to this module.

After rotation is registered, setup optionally seeds an integration connection from the first enabled stored account when no connection exists. Empty account storage skips both the catalog transform and connection write until the next restart. A connection-seeding failure is logged and leaves the catalog registration active. Repeated setup disposes the previous registrations before adding replacements.

### Request Flow

```
OpenCode API call
         │
         ▼
rotatingFetch(input, init)
         │
         ├── prefer available primary over sticky overage_fallback
         ├── if first overage_fallback for this request
         │     └── advisory GET /zen/go/v1/usage for cooling primaries
         │           all-ok ──▶ one advisory primary attempt
         │           else ──▶ keep overage candidate (fail open)
         ├── headers.set("Authorization", "Bearer <activeKey>")
         ├── await underlying transport(input, headers)
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
V1 user selects "Add Go Account"
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
9. **On initial all-unavailable entry:** Probe the sticky enabled credential once and return that real response. Never create a synthetic exhaustion response.
10. **On mid-request stale exhaustion:** Return the last real response. If none exists, preserve or throw the existing transport or error terminal. Never probe blocked or already-attempted credentials, and never create a synthetic response.
11. **On first overage crossing:** Before the first overage attempt, consult cooling primaries with a bounded usage lookup and allow at most one advisory primary attempt. Uncertainty fails open to the existing overage path only while the caller remains active; caller cancellation stops advisory classification and does not send overage. See [quota-rotation.md](./quota-rotation.md#advisory-usage-at-overage-crossing) for the full contract.

Traversal state is request-scoped, so one logical request attempts each enabled, available credential at most once. Auth blocks and cooldown deadlines are process-local. Per-account availability generations reject stale success and penalty mutations. Global request-success ordering prevents an older request from changing or persisting stickiness after a newer request succeeds, without serializing requests.

The interceptor accepts a `baseFetch` parameter for testability:

```ts
const { fetch } = createRotatingFetch(accounts, lastIndex, mockFetch)
```

### `runtime.ts` — Rotation Initialization

Loads the account and sticky-state files, chooses the process's starting account, and constructs `createRotatingFetch`. A successful replacement is mapped back to the current on-disk account by API key and `addedAt` before the sticky index is persisted.

### `v2-provider.ts` — Native V2 Transport

Exports the V2 provider-package `model(modelID, settings)` contract. It removes the private original-package setting, calls the corresponding native `@opencode/ai` model constructor, and decorates the returned route transport. The decorator converts each host request to a replayable Web `Request`; each credential attempt is converted back to a native Effect HTTP request and passed through the host-supplied middleware and handler. It removes stale `Authorization` and `x-api-key` values before applying the current account with the native protocol's scheme. Responses cross the bridge as streams. The rotating fetch clones only bodies it must inspect and applies its existing byte and time limits, while the returned branch remains readable.

The module is a separate package export. The root plugin entry does not import it, `@opencode/ai`, or Effect at runtime, so loading the V1 adapter does not initialize the V2 provider stack.

### `index.ts` — Plugin Entry

The default export follows OpenCode's temporary shared-package shape:

```ts
const plugin = {
  id: "oc-go-multi-auth",
  setup: async (ctx) => { /* V2 integration and catalog setup */ },
} satisfies Plugin.Plugin

export default { ...plugin, server } // V1 1.18.29+ calls server()
```

The adapters share only version-neutral account selection, persistence, and rotating-fetch construction. V1's `loader` and **Add Go Account** authorize function use `authClient.auth.set()` and return V1 auth hooks. V2 registers its key method through the integration editor and its package-local native transport through the catalog editor. Account listing, removal, and status are implemented separately in `cli.ts`.

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

The package default-exports one object with both runtime contracts:

```ts
export default {
  id: "oc-go-multi-auth",
  setup,  // OpenCode V2
  server, // OpenCode V1 1.18.29+
}
```

V1 passes `PluginInput` to `server()`:
- `client` — the typed OpenCode V1 SDK client used for `auth.set()`
- `project`, `directory`, `worktree`, `serverUrl`, `experimental_workspace`, `$` — standard context

The returned V1 `Hooks.auth` object has:
- `provider: "opencode-go"` — must match the target provider ID and stored auth ID
- `loader(getAuth) -> { apiKey, fetch }` — called at session start
- `methods: AuthMethod[]` — available to the user via command palette

The V1 auth methods use `type: "api"` for credential-based actions. V2 calls `setup()` and does not expose those methods, so V2 account management uses the `oc-go-multi-auth` CLI. The shared default export only packages both implementations together; it does not translate hooks or client calls between APIs.

---

## Security Considerations

- **API keys are stored in plaintext** on disk (`~/.config/opencode/`). Only the owner can read them (`0o600`).
- **Keys are held in memory** for the duration of the session.
- **Independent network calls** are limited to the advisory `GET https://opencode.ai/zen/go/v1/usage` lookup at the first primary-to-overage crossing. That request uses the captured underlying transport without recursively entering rotation. On V2 it still passes through the host-supplied HTTP middleware and handler.
- **Plugin API dependencies** use optional peers for the `@opencode-ai/plugin` V1 declarations and `@opencode/plugin` V2 declarations. The package-local V2 provider has direct runtime dependencies on the exact `@opencode/ai` 2.0.2 contract and its matching Effect release.
