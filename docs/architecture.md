# Architecture

How `oc-go-multi-auth` is built, how the modules interact, and where state lives.

---

## Module Overview

```
src/
├── types.ts           # Account, account-file, and rotation-hint types
├── storage.ts         # Account file reads, locked edits, account fingerprint, rotation hint
├── accounts.ts        # Add / list / set role / remove, returning display-safe summaries
├── rotate.ts          # Startup account selection (next enabled after the last-used one)
├── classification.ts  # Failure classifier shared by every transport
├── pool.ts            # Account policy: availability, cooldowns, roles, advisory usage, claims, settlement
├── fetch.ts           # V1 transport: the rotating fetch replay loop
├── v2-transport.ts    # V2 transport: session hooks for HTTP, WebSocket and retry
├── destination.ts     # V2 request-destination comparison (origin, path segments, ws/wss)
├── v2.ts              # V2 setup(): host check, RPC handlers, hook registration, activation
├── rpc.ts             # Portable RPC contract for account management (plain JSON Schema)
├── runtime.ts         # Startup snapshot for both hosts; writes the rotation hint
├── usage.ts           # Usage endpoint parse, per-account collection, report formatting
├── tui-flows.ts       # Host-neutral /go-accounts and /go-usage flows
├── tui.ts             # V1 tui() and V2 setup() for the terminal UI
├── index.ts           # Default export: V1 server() and V2 setup()
├── cli.ts             # oc-go-multi-auth command line
└── __tests__/
```

Package exports:

| Export | File | Loaded by |
|---|---|---|
| `.` | `dist/index.js` | OpenCode 1 (`server()`) and OpenCode 2 (`setup()`) server plugins |
| `./tui` | `dist/tui.js` | OpenCode 1 (`tui()`) and OpenCode 2 (`setup()`) terminal UI |
| `./rpc` | `dist/rpc.js` | Any client that wants to call the account RPC; it loads no host code |

None of the entries imports an OpenCode package at runtime; plugin API imports are type-only. That keeps the root and `./tui` loadable on OpenCode 1 without the V2 packages, and the reverse. There is no `./server` export, because OpenCode 1 would prefer it over the package root.

---

## Shared Account Policy

`pool.ts` owns every decision about which account carries an attempt. Both transports call it, so the business rules exist once:

- **Availability.** An account is available when it is enabled, not auth-blocked, and not inside a cooldown. Expired cooldowns are cleared on read.
- **Preference.** An available `primary` wins over an available `overage_fallback`. The sticky account is used when it is the preferred available choice.
- **Advisory usage.** When the only choice is an overage account and some primaries are cooling, a bounded usage lookup (750 ms, cached 5 s) may return to a cooling primary that still reports quota. On V1 each request tries a cooling primary at most once. On V2 the host retries on its own, so the pool remembers which cooling primaries an advisory lease already tried and skips them until they are available again; a failed advisory attempt therefore hands the next retry to the overage account instead of repeating.
- **Claims.** A lookup result is only a proposal, because awaiting it lets other attempts and settlements run. `claimCandidate()` turns a proposal into a lease in one synchronous step: it rejects an excluded or no-longer-available account and, for an advisory primary, one whose availability generation changed since the lookup or that was already offered in this cooldown, and it marks the advisory attempt only when it succeeds. Two attempts sharing one lookup therefore cannot both take the same primary. V1 keeps its own selection and re-check and does not use claims.
- **Exclusions.** `firstAvailable()` and `probeCandidate()` accept a set of account indexes to skip. The V2 agent loop passes the accounts its own failed attempts used (see Retry); a probe ignores the set only when every enabled account is in it.
- **Leases and settlement.** A lease records the account index, the account's availability generation, and a request generation. A success or penalty settles only while the generation is unchanged, and advances it. A penalty reports whether it was `applied`, `covered` (the lease was stale only because another attempt already recorded an equal or stronger penalty for the account), or `superseded` (a newer outcome replaced it). Only the newest successful request may move the sticky account. A late result therefore cannot overwrite a newer one.
- **Lifecycle.** `dispose()` aborts in-flight usage lookups and makes later settlements no-ops.

`classification.ts` turns a response, a decoded error body, or a parsed WebSocket frame into `auth`, `quota` (with a cooldown), `overload`, or nothing. Bodies are read from a clone, capped at 64 KiB and one second; 2xx bodies are never cloned. See [quota-rotation.md](./quota-rotation.md) for the signal list.

---

## OpenCode 1 Data Flow

```
1. OpenCode starts; opencode-go has a stored key, so the auth loader runs
2. runtime.ts reads the account file and the rotation hint
3. selectAccount() picks the next enabled account after the last-used one
4. the rotation hint is written; the account file is not
5. createRotatingFetch() wraps the host fetch with an account pool
6. the loader returns { apiKey: "", fetch }
```

The rotating fetch replays one logical request across accounts: it sets `Authorization: Bearer <key>`, classifies the response, settles a penalty, and tries the next preferred account, waiting for the earliest cooldown when every account is cooling. A successful replacement becomes sticky and is written to the rotation hint, mapped to the current account file by API key and `addedAt`.

The V1 auth hook offers OpenCode's stock single-key method (`{ type: "api", label: "Go API key" }`). Pool accounts are managed with `/go-accounts` or the CLI.

---

## OpenCode 2 Data Flow

`setup()` first checks the host. The OpenCode 1 preview loader also calls `setup()` with a smaller context; that context is recognised and skipped with a log entry, because `server()` already covers OpenCode 1. A V2 host older than 2.0.28, or one without session hooks, RPC, provider lookup, or key connections, fails setup with an error naming the supported range.

On a supported host, setup:

1. registers the account RPC (`rpc.ts`, handlers in `v2.ts`);
2. loads the startup snapshot; with no enabled account it stops here and rotation starts after a restart;
3. registers five session hooks scoped to provider `opencode-go`: `http.request`, `http.response`, `experimental.ws.handshake`, `experimental.ws.receive`, and `retry`, and subscribes to the host's event stream so a finished session's state can be dropped;
4. connects the first eligible pool key to the `opencode-go` integration when the provider is still bound to that integration and the integration has no active connection. An existing connection is never replaced, and a failure is logged without stopping rotation.

The cleanup function stops the event subscription, disposes the transport (aborting session scopes and clearing its maps and the pool), and disposes every registration.

### Credential authorization

OpenCode 2 lets a provider be rebound to another integration, for example an OpenCode Console one with its own gateway and organization headers, and it can rebind between the moment a request is prepared and the moment the transport hook runs. The pool's personal keys must never reach another integration's gateway, so every credential write passes one authorization boundary (`createAuthorization()` in `v2.ts`) that reads the provider with `ctx.provider.get("opencode-go")` and checks two things:

1. **Owner.** The provider's `integrationID` is absent or `opencode-go`. A custom base URL on the Go integration is still the pool's.
2. **Destination.** The URL the request is about to reach lies under a base URL that OpenCode's current configuration gives Go: the provider's `settings.baseURL`, then, only when that does not match, the selected variant's or the model's `settings.baseURL` from the public model list (`ctx.model.list()`, which already merges the catalog with the user's overrides). The plugin carries no list of Go endpoints of its own, and it does not rebuild the host's model resolution. `destination.ts` compares the exact origin (scheme, host and port, with `https`/`wss` and `http`/`ws` treated as the same origin, so a `ws` request to an `https` base is a downgrade and is refused) and a path equal to the base's or below it on a segment boundary. Queries and fragments never widen the match, and `..` segments are resolved before comparing. A base URL still containing an unexpanded `${...}` variable matches nothing.

After the model-list lookup, the provider owner and base URL are reread; model URLs come from that lookup. Authorization runs again after the advisory lookup, the last wait before a key is written, so the write follows the check synchronously. JavaScript cannot make the host's state and the write atomic, so the guarantee is the concrete one: the key is written only onto a URL that the configuration read just before the write names.

When the check fails the hook leaves the request and the retry decision to the host, the account RPC reports the activation as `unsupported` with the reason, nothing is connected, and the log records `rotation inactive` once per change. Reasons name an origin and never a path, query or configured value. A reroute that no public configuration describes, such as a `model.request` hook that changes the base URL, cannot be told apart from a foreign gateway and is refused too. The check without a destination (activation, retry decisions) is the owner check alone. `ctx.model.list` is optional: without it only the provider's base URL can authorize. The plugin never changes the host's integration binding.

### Session scope

Hooks receive no cancellation signal, and the plugin does not rely on a request's own `signal` to learn that the user interrupted. The transport therefore keeps one scope per session for what must not outlive an execution: the WebSocket exchange in flight, the agent loop's retry chain (see Retry), and an abort controller for the advisory lookup wait. `session.execution.succeeded`, `.failed`, `.interrupted`, and `session.deleted` events end a scope: its exchange and chain are dropped and its wait is abandoned (the lookup itself is shared through the pool and keeps running for other requests). After every wait in a hook (authorization, the advisory lookup, response classification) the hook checks that its scope is still alive before it touches session state, rewrites a credential, registers a lease or exchange, or records a failure. An attempt whose session ended while it waited therefore leaves the host's request unchanged and registers nothing. Ending a scope says nothing about requests already on the wire: the plugin does not claim they were cancelled or settled, and a response that arrives later still settles the pool, because pool settlements are account facts, while the ended chain is not written. Requests without a scope (an auxiliary request that arrives before any agent-loop request of its session) are bounded by the pool's lifetime instead.

### HTTP

`http.request` takes a lease after the authorization above, replaces the existing `Authorization: Bearer` or `x-api-key` value with the lease's key, and remembers the lease in a `WeakMap` keyed by the request object. Requests without a credential header are left alone. `http.response` looks up the final request object, checks that it still carries the lease's key, and settles once: success for a 2xx (the body is not cloned), otherwise the classifier's verdict. If the request object changed or another hook changed the credential, nothing is settled; the plugin never guesses which account produced a response.

### WebSocket

The host serializes WebSocket exchanges per session, so the transport keeps one exchange per session. `experimental.ws.handshake` takes a lease and replaces the credential header; a changed key makes OpenCode open a new socket. Frames are observed, never rewritten. `response.created` records the response id; a `response.completed` with the same id settles success. `error` and `response.failed` frames are classified and settled. Malformed, incomplete, cancelled, or disconnected exchanges settle nothing. When an exchange falls back to HTTP, the next `http.request` of the same kind abandons it.

### Retry

The `retry` hook classifies the host's decoded error (status and response body; a WebSocket `response.failed` frame is unwrapped to its nested error, as on the receive path). The event names neither the request nor its kind, so the hook relies on a per-session record of the agent loop (`primary` and `compaction` requests; the host runs them one at a time per session):

- the credential failure class (`auth` or `quota`) of the latest attempt, cleared when the next attempt starts and consumed by the retry hook;
- the accounts this retry chain has failed with.

Both are recorded from the attempt's own lease whenever the response or frame is classified as an auth or quota failure, whatever the pool then did with it. The pool may refuse or only partly apply the penalty because a concurrent auxiliary request (for example a title) already advanced the account's availability generation; that decides what the *pool* believes about the account, but the agent loop's attempt still failed with that account and must not be sent back to it. The pool's shared availability rules are unchanged by this, and V1 does not use these records.

The chain's next attempts skip its failed accounts; auxiliary requests (`title`, `generate`) never do, and their successes never clear the chain. An agent-loop success, a retry decision that ends the pass (below), or the end of the session clears it.

For an auth or quota failure the hook decides among the accounts that are available and not in the chain's set:

| Situation | Decision |
|---|---|
| One is available, and the latest attempt recorded a failure of the event's class | retry immediately |
| One is available, no matching record (an unattributed or auxiliary failure, or another class) | the host's decision |
| None, but accounts remain available globally (the chain has failed with all of them) | the host's decision, bounded by its attempt limit; the pass restarts with every account eligible |
| None available, some cooling | retry when the earliest cooldown ends; the pass restarts then |
| None available, every account blocked | no retry |

Overloads, unknown 429s, and failures it could not attribute keep the host's decision; they never create a synthetic retry. A globally blocked account is never reached through the local set. OpenCode's attempt limit always applies, and when the host ends a turn without consulting the hook the session-end event drops the chain.

### Accepted bounded adaptation

Promise hooks receive no cancellation signal, so the V2 transport never waits inside a hook for a cooldown. When every account is cooling, `http.request` probes the sticky account (skipping the chain's failed accounts while another enabled one exists) immediately and the retry hook's delay carries the wait. The only bounded waits inside hooks are the advisory usage lookup (750 ms, ended early when the session ends), the provider and model lookups, and response classification (1 s). The order inside a hook is: authorize, advisory lookup when only an overage account is usable, authorize again, then, with no wait in between, claim the lease, write the credential and register the attempt. The host's retry budget is accepted as it is: its attempt limit and delay schedule bound how often a chain retries, including when every account has failed the chain.

### Coverage

Session hooks cover the agent loop, compaction, title generation, and `session.generate`. Title and `session.generate` requests get an account and are attributed, but they do not go through the session retry decision. `ctx.generate.text` runs outside sessions and is not covered.

---

## Account Management

`accounts.ts` implements add, list, set role, and remove once. Three front ends call it:

- the CLI, which addresses accounts by their 1-based number;
- the V1 TUI, which edits the local file directly;
- the V2 RPC, which the V2 TUI calls through `context.client.rpc(GoAccountsRpc)` and which also works for remote clients.

The TUI selects accounts by a stable id (a truncated SHA-256 of `addedAt` and the key) rather than by position, so an account that moved or disappeared since the list was shown is rejected with a clear message instead of editing the wrong entry. Duplicate keys stay allowed, so an add moves `addedAt` forward by a millisecond, under the edit lock, when the same key was added at the same time; an id shared by two accounts in an older file is rejected rather than resolved to the first match (use the CLI number). Numbers given to the CLI are resolved inside the locked edit. Summaries carry a masked key hint and never the key; error messages never contain a key.

Edits apply to the running plugin after a restart. Adding an account through `/go-accounts` also connects OpenCode Go when it has no stored key; the save and the connection are reported separately. OpenCode 1 reads the provider's public `source`: `api` means a stored key exists and is kept, `env`, `config`, and `custom` are reported as such even when a stored key sits underneath, and the public API cannot show that key, so the TUI asks whether to connect the pool account (replacing any stored OpenCode Go key) or keep the current connection unchanged, in which case rotation needs a stored key and a restart. OpenCode 2 reads the active connection and the provider ownership described above.

---

## Storage

| File | Owner | Contents |
|---|---|---|
| `~/.config/opencode/opencode-go-accounts.json` | account edits | `{ version, accounts, rotationIndex }` |
| `~/.config/opencode/opencode-go-accounts.json.lock` | the edit holding it | process id and timestamp, for diagnosis only |
| `~/.config/opencode/opencode-go-rotation.json` | the running plugin | `{ lastUsedIndex, lastUsedAccount }` |

```json
{
  "version": 1,
  "accounts": [
    { "apiKey": "go_xxxxxxxxxxxx", "label": "Work", "addedAt": 1745800000000, "enabled": true, "role": "primary" }
  ],
  "rotationIndex": 0
}
```

```json
{ "lastUsedIndex": 0, "lastUsedAccount": "3f2a9c01d4b7e865" }
```

**Edits** take an exclusive lock file (`open(..., "wx")`), wait up to two seconds for it, and then fail with a busy error that names the lock path. A lock is never broken based on its age or process id; if no edit is running, delete the file by hand. Under the lock the account file is read strictly: unparseable or mis-shaped content stops the edit with an error and a `.bak.<timestamp>` copy, and nothing is written.

**Writes** go to a unique temporary file created with mode `0600`, are flushed, and are renamed into place.

**Reads** for the running plugin and for listings are lenient: unparseable content is copied to a `.bak.<timestamp>` file and treated as an empty account list, leaving the original file untouched.

**The rotation hint** is written only by the running plugin, at startup and when the sticky account changes. It is resolved by `lastUsedAccount` first and by `lastUsedIndex` when the fingerprint is absent or no longer matches. `rotationIndex` in the account file is a legacy field: it is still read for compatibility and kept by edits, but the runtime no longer writes it.

---

## Security Considerations

- **API keys are stored in plaintext** in `~/.config/opencode/`, readable only by the owner (`0600`).
- **Keys stay inside the plugin.** RPC results, TUI dialogs, toasts, logs, and CLI output show labels and `...abcd` hints. Activation errors have the key replaced with `[redacted]`.
- **Independent network calls** are the advisory usage lookup and the user-run `/go-usage` or `oc-go-multi-auth usage`, all to `GET https://opencode.ai/zen/go/v1/usage` with each account's bearer key.
- **Plugin API dependencies** are optional peers: `@opencode-ai/plugin` for V1 and `@opencode/plugin` for V2. The package has no runtime dependency on OpenCode or Effect.
