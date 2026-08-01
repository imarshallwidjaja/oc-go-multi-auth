# Credential and Quota Failover

The plugin attaches to OpenCode's `opencode-go` provider and keeps one working Go credential sticky during a live OpenCode process. It reacts to provider responses and account preference roles. There is no dashboard quota scrape or per-request round robin.

## Account Roles

Each account has a preference role:

| Role | Meaning |
|---|---|
| `primary` | Prefer this account whenever it is available (default) |
| `overage_fallback` | Use only when no primary is available — for accounts with paid overages enabled |

Tag the overage safety-net account with `oc-go-multi-auth set-role <n> overage_fallback` (or **Set Go Account Role** in Auth settings). Leave ordinary accounts as `primary`.

## Sticky Selection

At process start, the loader reads `lastUsedIndex` from `~/.config/opencode/opencode-go-rotation.json`, selects the next enabled account, stores it under auth ID `opencode-go`, and uses it as the initial sticky account.

Successful ordinary requests continue to use that account when it remains the preferred available choice. When failover finds a successful replacement, the replacement becomes sticky for later requests and its index is written through the same rotation-state files. The next process starts its normal round-robin selection from that persisted position.

## Preference Demotion

On every request, before the first upstream attempt, the plugin prefers an available `primary` over an available `overage_fallback`. If sticky is currently an overage fallback and any primary is available (enabled, not auth-blocked, cooldown finished), sticky switches to that primary and the request uses it once — no probing of other keys on that request.

While all primaries are cooling or blocked, requests stay on the overage fallback with a single attempt (no extra latency). As soon as a primary becomes available again, the next request demotes sticky off overage. That keeps paid overages as a last resort without relying on a new OpenCode session.

## Rotatable Responses

The plugin blocks the current credential for the rest of the process and rotates for:

- HTTP 401 Unauthorized
- HTTP 402 Payment Required
- clear invalid or revoked API key signals
- clear authentication failures
- clear model entitlement or access failures

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

- bare 5xx responses without a credential-scoped signal
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

Each pass within a logical request has its own attempted set. It prefers available `primary` accounts over `overage_fallback` accounts: if sticky is an available primary it starts there, otherwise the next available primary, otherwise sticky when it is an available overage fallback, otherwise the next available overage fallback. Within a pass each enabled, available credential is considered at most once. Disabled accounts, process-blocked credentials, and credentials with an active cooldown are skipped.

Auth blocks and cooldown deadlines exist only in the live plugin process and are never persisted to the account or rotation files. A cooldown expires at its deadline, automatically making the account available to normal full traversal again. Process restart clears every block and cooldown.

If every remaining usable credential is cooling, the request waits until the earliest cooldown expires, clears only its per-pass attempted set, and starts another pass. The wait observes the caller's abort signal. The request continues until an account succeeds, an upstream response is non-rotatable, every enabled credential is permanently auth-blocked, or the caller cancels. When all enabled credentials are already auth-blocked at the start of a later request, the plugin probes the sticky enabled credential once so it can still return a real upstream response. The plugin never synthesizes `all Go accounts exhausted`.

## Request Replay

Before the first attempt, the plugin creates a `Request` template and clones it for each credential attempt. This preserves the URL, method, signal, headers, and body, including JSON bodies supplied through either `RequestInit` or an input `Request`. Only the Authorization value is replaced.

If the input is consumed or otherwise cannot be cloned, the plugin fails closed before making an upstream attempt and does not replay the body with any credential.

Successful SSE streams are returned immediately and are never buffered or inspected. Errors that arrive after an initial successful streaming response cannot be transparently replayed because the response has already started and stream data may already have reached OpenCode.

## Concurrency

Successful requests are not globally serialized. Each logical request receives an increasing generation at start, and each attempt captures its account's availability generation. An accepted success or penalty must still match that account generation and then advances it, so stale successes and penalties cannot overwrite newer cooldown, block, or success state. Auth blocks take precedence over stale quota responses.

Every accepted success also records its request generation, including success on the current sticky account. Only a success newer than the last accepted success may change or persist the sticky account. An older success still returns to its caller but cannot steal stickiness after a newer request succeeds.

## No Proactive Quota Detection

The plugin does not query a dashboard or estimate token usage. Preference roles and response-driven cooldowns are the only signals used to leave an overage fallback. To inspect actual subscription quota, use [opencode.ai/auth](https://opencode.ai/auth).
