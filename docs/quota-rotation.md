# Credential and Quota Failover

The plugin attaches to OpenCode's `opencode-go` provider and keeps one working Go credential sticky during a live OpenCode process. It reacts to provider responses and account preference roles. There is no dashboard quota scrape or per-request round robin.

Account selection, roles, cooldowns, advisory usage, and response classification are shared by both hosts. They differ in who repeats a failed request: on OpenCode 1 the plugin's fetch replays it (see [Traversal and Penalties](#traversal-and-penalties)); on OpenCode 2 OpenCode's own retry loop does (see [OpenCode 2](#opencode-2)).

## Account Roles

Each account has a preference role:

| Role | Meaning |
|---|---|
| `primary` | Prefer this account whenever it is available (default) |
| `overage_fallback` | Use only when no primary is available — for accounts with paid overages enabled |

Tag the overage safety-net account with `oc-go-multi-auth set-role <n> overage_fallback` or with `/go-accounts`. Leave ordinary accounts as `primary`.

## Sticky Selection

At process start, the plugin reads the last-used account from `~/.config/opencode/opencode-go-rotation.json` (by fingerprint, or by the legacy `lastUsedIndex` when no fingerprint matches), selects the next enabled account, and uses it as the initial sticky account. It records that choice in the same file; it does not write the account file or OpenCode's auth store.

Successful ordinary requests continue to use that account when it remains the preferred available choice. When a different account succeeds, it becomes sticky for later requests and is recorded in the rotation file. The next process starts its round-robin selection after it.

## Preference Demotion

On every request, before the first upstream attempt, the plugin prefers an available `primary` over an available `overage_fallback`. If sticky is currently an overage fallback and any primary is available (enabled, not auth-blocked, cooldown finished), sticky switches to that primary and the request uses it once — no probing of other keys on that request.

While all primaries are cooling or blocked, ordinary traversal stays on the overage fallback with a single attempt. Before that first overage attempt, the plugin may make a short advisory usage lookup against cooling primaries; uncertain or rate-limited guidance keeps the existing overage path. As soon as a primary becomes available again, the next request demotes sticky off overage. That keeps paid overages as a last resort without relying on a new OpenCode session.

## Rotatable Responses

The plugin blocks the current credential for the rest of the process and rotates for:

- HTTP 401 Unauthorized
- HTTP 402 Payment Required
- clear invalid or revoked API key signals
- clear authentication failures
- clear model entitlement or access failures
- the OpenCode Go message `An active OpenCode Go subscription is required to use Go models.`, which blocks that account even when the provider wraps it in a 5xx response or an `Upstream request failed:` prefix

The plugin applies a temporary cooldown and rotates for clear quota, rate-limit, or usage-limit signals. The default cooldown is 60 seconds. After the body or a structured discriminator establishes one of those conditions, a positive numeric-seconds or future HTTP-date `Retry-After` value sets the cooldown instead, capped at 10 minutes. Malformed, zero, or past values use the default cooldown.

For non-success responses, the plugin incrementally inspects a clone of a text or JSON body for at most 64 KiB and one second. A 429 without a content type is inspected as bounded plain text. Plain text rotates only on terminal phrases. JSON rotates only when top-level `code`/`type`, nested `error.code`/`error.type`, or selected error message fields identify a credential-scoped condition such as:

- rate limit or usage limit
- quota exhaustion
- invalid or incorrect API key
- authentication failure
- model entitlement or access failure

An explicit overload, capacity, or engine-overloaded signal on a 429 takes precedence over `Retry-After`: the plugin returns that original response without rotating or penalizing the account. Unknown, bare, and otherwise unclassifiable 429 responses are handled the same conservative way, even when they include `Retry-After`.

The original response body remains available to OpenCode whenever the plugin stops on a non-rotatable response or every enabled credential becomes auth-blocked. The plugin does not replace the provider's status and details with a synthetic error.

The following do not rotate credentials:

- bare 5xx responses without a credential-scoped signal (the Go subscription message above is such a signal)
- validation failures
- network exceptions and aborts
- bodies declared over 64 KiB, or bodies that reach 64 KiB without a decisive signal
- binary or otherwise unclassifiable error bodies
- bodies that reach the inspection deadline without a decisive signal
- non-401/402/429 SSE responses
- any successful 2xx response
- 429 overload or capacity responses
- unknown or bare 429 responses

HTTP 401 and 402 are classified before content type, so they rotate even when the response declares `text/event-stream`. A 429 SSE response is not inspected, and `Retry-After` alone does not make it rotatable.

## Traversal and Penalties

This section describes the OpenCode 1 replay loop. Each pass within a logical request has its own attempted set. It prefers available `primary` accounts over `overage_fallback` accounts: if sticky is an available primary it starts there, otherwise the next available primary, otherwise sticky when it is an available overage fallback, otherwise the next available overage fallback. Within a pass each enabled, available credential is considered at most once. Disabled accounts, process-blocked credentials, and credentials with an active cooldown are skipped.

Auth blocks and cooldown deadlines exist only in the live plugin process and are never persisted to the account or rotation files. A cooldown expires at its deadline, automatically making the account available to normal full traversal again. Process restart clears every block and cooldown.

If every remaining usable credential is cooling, the request waits until the earliest cooldown expires, clears only its per-pass attempted set, and starts another pass. The wait observes the caller's abort signal. The request continues until an account succeeds, an upstream response is non-rotatable, every enabled credential is permanently auth-blocked, or the caller cancels. When all enabled credentials are already auth-blocked at the start of a later request, the plugin probes the sticky enabled credential once so it can still return a real upstream response. The plugin never synthesizes `all Go accounts exhausted`.

## Request Replay

On OpenCode 1, before the first attempt, the plugin creates a `Request` template and clones it for each credential attempt. This preserves the URL, method, signal, headers, and body, including JSON bodies supplied through either `RequestInit` or an input `Request`. Only the Authorization value is replaced.

If the input is consumed or otherwise cannot be cloned, the plugin fails closed before making an upstream attempt and does not replay the body with any credential.

Successful SSE streams are returned immediately and are never buffered or inspected. Errors that arrive after an initial successful streaming response cannot be transparently replayed because the response has already started and stream data may already have reached OpenCode.

## Concurrency

Successful requests are not globally serialized. Each logical request receives an increasing generation at start, and each attempt captures its account's availability generation. An accepted success or penalty must still match that account generation and then advances it, so stale successes and penalties cannot overwrite newer cooldown, block, or success state. Auth blocks take precedence over stale quota responses.

Every accepted success also records its request generation, including success on the current sticky account. Only a success newer than the last accepted success may change or persist the sticky account. An older success still returns to its caller but cannot steal stickiness after a newer request succeeds.

## Advisory Usage at Overage Crossing

The plugin does not poll usage, estimate tokens, or probe on every request. The only independent usage lookup happens when ordinary traversal is about to choose the first `overage_fallback` for that logical request.

At that boundary it concurrently queries `GET https://opencode.ai/zen/go/v1/usage` for enabled, unblocked, currently cooling, not-yet-attempted primaries. A strictly valid 200 payload whose rolling, weekly, and monthly windows are all `ok` permits exactly one advisory attempt of the first such primary in ring order. Any `rate-limited` window makes that candidate ineligible. Timeout, network failure, non-200, or malformed or oversized JSON fail open to the existing overage path and do not mutate account state.

Usage data never changes blocked, cooldown, sticky, role, or persistence state by itself. The advisory attempt uses the same success and response-classification path as any other attempt. If a cooling primary becomes available while the lookup is in flight, the request re-runs ordinary selection and treats that primary as a normal attempt, not an advisory one. Immediately before each model attempt, the chosen credential is re-checked; an advisory primary or preserved overage that is no longer usable is skipped without sending that attempt, and ordinary selection continues. If the advisory attempt does not succeed, routing resumes the original overage candidate when it is still available; otherwise ordinary traversal continues. Caller cancellation during the advisory attempt or its response classification aborts the request and does not resume overage. Lookups are process-local, generation-scoped, and fail open; they are not scheduled from `resetsAt`. To inspect stored-account quota windows, run `/go-usage` in OpenCode or `oc-go-multi-auth usage`. Both call `GET https://opencode.ai/zen/go/v1/usage` with each enabled account's bearer key. That response is percent-used for the rolling (5-hour), weekly, and monthly windows; it does not currently include remaining dollars (OpenCode issue #44189).

## OpenCode 2

OpenCode 2 sends every request itself, through its stock `opencode-go` provider and transport, and retries failed model calls with its own bounded schedule. The plugin does not replay requests there. It chooses the account for each attempt, attributes the outcome, and adjusts OpenCode's retry decision.

**Choosing an account.** Each HTTP request and each WebSocket handshake takes a lease from the shared pool, using the same preference and advisory-usage rules as above, and replaces the existing credential header with that account's key. There is no per-session account: consecutive attempts may use different accounts as availability changes. An agent-loop retry chain additionally skips the accounts its own earlier attempts failed with (see Steering retries); title and other auxiliary requests do not.

**Attributing outcomes.** An HTTP response settles against the lease of the request object that carried it, provided the request still carries that key. A 2xx settles success without cloning the body; other statuses go through the bounded classifier on a clone, so OpenCode still receives the original stream. A WebSocket exchange settles success on `response.completed` for the response id seen in `response.created`, and settles a penalty for classified `error` or `response.failed` frames. A `response.failed` frame settles only for the response id that `response.created` announced. Malformed frames, `response.incomplete`, cancellations, disconnects, exchanges abandoned by an HTTP fallback, and exchanges whose session ended settle nothing. When correlation is lost, the plugin applies no penalty rather than guess.

When two attempts share an account, the first failure records the penalty and the second is attributed to the same account without changing it. A failure that arrives after a newer outcome replaced the account's state, such as a title request's success, leaves the account's shared state alone; the agent loop's own attempt still failed with that account, so its retry is steered away from it.

**Steering retries.** The `retry` hook classifies OpenCode's decoded error from its status and response body:

| Situation | Decision |
|---|---|
| Auth or quota failure of the session's latest agent-loop attempt (same class as the event), an account that chain has not failed with is available | retry immediately |
| Auth or quota failure, no matching record (including a title or other auxiliary request's failure, or an earlier turn's), such an account available | OpenCode's decision |
| Auth or quota failure, the chain has failed with every account that is available | OpenCode's decision, and the next attempt may use any available account again |
| Auth or quota failure, every remaining account cooling | retry when the earliest cooldown ends |
| Auth or quota failure, every account blocked | no retry |
| Overload, unknown 429, anything else | OpenCode's decision |

OpenCode's maximum attempt count always applies. The plugin records the failure and the failed account when the response or frame arrives, whether or not a concurrent request had already changed that account's shared state. That keeps a quota failure on the main request from being lost when a title request succeeded on the same account first, and it keeps a retry chain from ping-ponging back to an account it just failed with. The record of the latest failure is cleared when the next agent-loop attempt starts, so a failure left over from a turn that ran out of attempts never steers a later turn. The failed-account set ends with an agent-loop success, a decision above that ends the pass, or the session's end event. A WebSocket `response.failed` frame is classified from its nested error, so quota failures that arrive that way are retried like HTTP ones.

**Advisory attempts across retries.** A cooling primary is offered through the advisory lookup once per cooldown: after an advisory attempt on it, OpenCode's next retries use the overage account, including new requests, until the primary's cooldown ends or it succeeds. After that it is an ordinary candidate again, and a later cooldown earns another advisory attempt. After the lookup the plugin claims the chosen account in one synchronous step that re-checks it (still available, not excluded, and for an advisory primary unchanged since the lookup and not already offered), and picks again if it was blocked, cooled, or taken by another attempt in the meantime. Two attempts sharing one lookup therefore never both take the same cooling primary.

**Providers and destinations bound elsewhere.** If OpenCode has rebound `opencode-go` to another integration (for example a Console one), the hooks do nothing: no key is substituted, no outcome is attributed, and the retry decision stays with OpenCode. The same holds for a single request whose URL is not under a base URL OpenCode's current configuration gives Go (the provider's, or the selected model's or variant's), such as a request prepared for a Console gateway just before a rebind back to Go. The log records `rotation inactive` with the reason, naming only the destination's origin. See [Credential authorization](./architecture.md#credential-authorization).

**No waiting inside hooks.** OpenCode's Promise hooks have no cancellation signal, so the plugin never waits for a cooldown inside one. When every account is cooling, the next request probes the sticky account immediately and the retry delay carries the wait. Hooks wait only for the provider and model lookups, the advisory usage lookup (at most 750 ms, abandoned when the session's execution ends) and body classification (at most one second). After each wait a hook checks that its session is still running before it rewrites a credential or records state, so an attempt whose session ended meanwhile is left as the host built it.

**Coverage.** Agent-loop and compaction requests use the full flow above. Title generation and `session.generate` requests get an account and settle outcomes but are not retried through the session retry hook. Stateless `ctx.generate.text` calls run outside sessions, so the session hooks do not see them and they get no account rotation.
