# Authentication

How `oc-go-multi-auth` gets its keys onto OpenCode Go requests.

---

## Overview

OpenCode's Go subscription uses **API key authentication**. Each Go account comes with a unique API key from the OpenCode dashboard.

The plugin keeps a pool of Go API keys in its own account file and puts one of them on each `opencode-go` request. OpenCode separately stores its own single key for the `opencode-go` provider. The plugin needs that host key to exist, because OpenCode only treats the provider as connected when it has one, but the plugin replaces it on the wire with a pool key.

---

## Getting Go API Keys

1. Open [opencode.ai/auth](https://opencode.ai/auth) in your browser.
2. Sign in with your Go subscription account.
3. Generate an API key and copy it. It looks like `go_xxxxxxxxxxxx`.
4. Repeat for each Go subscription you want to use.

Each key is tied to one Go subscription and its quota.

---

## Adding Pool Accounts

Use `/go-accounts` inside OpenCode, **Add Go Account** in OpenCode 1's provider connect flow, OpenCode 2's own provider settings, or the CLI:

```sh
oc-go-multi-auth add --key <key> --label "Work" --role primary
```

See [account-management.md](./account-management.md) for the full workflow, including [keys connected in OpenCode 2's provider settings](./account-management.md#keys-connected-in-opencode-2s-provider-settings). Restart OpenCode after changing the pool; the running plugin keeps the account list it loaded at startup.

---

## Connecting OpenCode Go

OpenCode needs one connected `opencode-go` key before it routes Go requests at all. `/go-accounts` and V2 setup fill that in only when it is missing, and never replace a key you connected yourself. **Add Go Account** is the one path that always connects its key, because choosing it is the request to connect:

| Host | When | What the plugin does |
|---|---|---|
| OpenCode 1 | **Add Go Account** completes in OpenCode's provider connect flow | Adds the account to the pool, then returns the key to OpenCode, which stores it as the `opencode-go` key and replaces any key stored before. The previous key stays in the pool only if it was a pool account |
| OpenCode 1 | `/go-accounts` adds an account | If `opencode-go` is not connected, stores the new key with the V1 SDK's `auth.set`. A stored key is kept. The public API reports a connection from the environment or configuration as such even when a stored key sits underneath, and it cannot show that key, so the TUI asks you to choose **Connect pool account** (replaces any stored OpenCode Go key) or **Keep current connection** (the connection is left unchanged; rotation needs a stored key and a restart) |
| OpenCode 2 | `/go-accounts` adds an account | If `opencode-go` has no active connection, connects the new key with `integration.connect.key` |
| OpenCode 2 | plugin setup at startup | If `opencode-go` has no active connection, connects the first eligible pool key |

OpenCode 2 never connects a key when `opencode-go` has been rebound to another integration such as an OpenCode Console one; see [Credential authorization](./architecture.md#credential-authorization). The standalone CLI cannot reach the host, so it never connects anything: use `/go-accounts` or the host's own connect flow.

The account is saved first. A failed connection is reported separately ("Saved …, but connecting OpenCode Go failed") with any key in the message replaced by `[redacted]`, and the pool account stays saved.

You can also connect a key yourself with OpenCode's stock flow: `opencode auth login` and the **Go API key** method on OpenCode 1, or **Go Accounts** → **Add account** → **Use API key** in OpenCode 2's provider settings. On OpenCode 1 that stores one key in OpenCode and adds nothing to the pool. On OpenCode 2 the plugin also adds a newly connected key to the pool as a `primary` account unless the pool already holds it, and the server uses it after a restart; see [Keys connected in OpenCode 2's provider settings](./account-management.md#keys-connected-in-opencode-2s-provider-settings). Removing a pool account does not remove a connected host key; remove that through OpenCode's own provider settings.

---

## OpenCode 1: The Auth Loader

OpenCode 1 runs the plugin's `auth.loader` only when its auth store has a key for `opencode-go`. The loader reads the account file, selects the starting account, and returns:

```ts
return {
  apiKey: "",
  fetch: rotatingFetch,
}
```

OpenCode uses the returned `fetch` for every `opencode-go` call. The rotating fetch sets `Authorization: Bearer <key>` for the current pool account and replays a cloneable request with another account when a credential or quota failure calls for it. The loader does not write to OpenCode's auth store.

The auth hook lists OpenCode's stock single-key method (**Go API key**) first, so `opencode auth login` and the provider dialog keep working as they do without the plugin. **Add Go Account** follows it; see [Add Go Account](./account-management.md#add-go-account-opencode-1-provider-connect). The account file is written by that method's completion, never by the loader.

---

## OpenCode 2: Session Hooks

OpenCode 2 keeps its stock `opencode-go` provider, model protocols, and transports. The plugin registers session hooks scoped to `opencode-go`:

- `http.request` replaces the existing `Authorization: Bearer` or `x-api-key` value with the chosen pool key. Requests without a credential header are not touched.
- `experimental.ws.handshake` does the same for a WebSocket connection's headers. A changed key makes OpenCode open a new socket.

Both hooks write a key only after the authorization check described in [Credential authorization](./architecture.md#credential-authorization) passes: the provider must still belong to the Go integration, and the request's URL must lie under a base URL that OpenCode's current configuration gives Go.
- `http.response`, `experimental.ws.receive`, and `retry` observe outcomes and steer OpenCode's retry; see [quota-rotation.md](./quota-rotation.md#opencode-2).

Nothing is placed in provider settings, and no provider package, model package, or transport is replaced.

---

## Troubleshooting

**"No Go accounts configured"**
→ The pool is empty. Add an account with `/go-accounts` or `oc-go-multi-auth add`.

**OpenCode 1: requests do not rotate after adding the first account**
→ OpenCode 1 runs the loader only when `opencode-go` has a stored key. If `/go-accounts` reported that connecting failed or that the connection was left unchanged, connect any Go key with `opencode auth login` (or choose **Connect pool account** when `/go-accounts` asks), then restart OpenCode.

**OpenCode 2: "account rotation is inactive: OpenCode Go is bound to the … integration"**
→ The provider now belongs to another integration, such as a Console one, and the plugin deliberately leaves its requests alone. Rebind `opencode-go` to the Go integration in OpenCode's configuration to use the pool; the plugin does not change that binding.

**OpenCode 2: "rotation inactive: The request to … is not under a base URL configured for OpenCode Go"**
→ A request for the Go provider was headed somewhere other than the Go provider's base URL (`settings.baseURL`), the selected model's, or the selected variant's, so the plugin left the host's credential on it. This protects a request that was prepared for another gateway, for example before a rebind. It also means a plugin that reroutes Go traffic with a `model.request` hook is not supported by rotation. The message names the destination's origin only, never a path or query. If the message says the base URL "contains an unresolved `${...}` variable", the configuration value was not expanded; fix the variable. If it says no base URL is configured, set `settings.baseURL` for the provider.

**OpenCode 2: plugin setup fails with "supports OpenCode 1.18.29+ (V1) and >=2.0.28 <3 (V2)"**
→ The host is older than 2.0.28 or lacks the session hook, RPC, provider lookup, or key-connection APIs. Update OpenCode.

**OpenCode 2: a key connected in OpenCode's provider settings is not in the pool**
→ Check `~/.config/opencode/oc-go-multi-auth.log`. `account imported` means it was added; restart the server to use it. `account import skipped` with "an account already holds this key" means the pool already had that key. Keys stored before the server started are never imported, and neither are credentials stored through a sign-in or external method. `account import unavailable` or `account import stopped` means imports are off until the server restarts. In every case you can add the key with `/go-accounts` or `oc-go-multi-auth add`.

**New accounts or roles have no effect**
→ Restart OpenCode. Edits are saved immediately but apply to the running plugin only after a restart. **Add Go Account** completed in the web UI or the TUI is the exception, because OpenCode reloads its server instance after the connection. `opencode auth login` runs in its own process, so a server that was already running needs a restart.

**OpenCode 1: Add Go Account fails**
→ The method saves the account to the pool first and then asks OpenCode to store the key. The two steps are not one transaction and nothing is rolled back, so a failure does not by itself say which step stopped. A missing key or label, or a role other than `primary` or `overage_fallback`, is rejected before anything is written. A busy or damaged account file also fails before the pool changes; `~/.config/opencode/oc-go-multi-auth.log` has an `add go account failed` entry with the reason, and [Concurrent Edits and Damaged Files](./account-management.md#concurrent-edits-and-damaged-files) explains the fix. If OpenCode fails afterward while storing the key or reloading, the account stays in the pool and the plugin's log has no entry for that failure.
→ When the outcome is unclear, check the pool on the server with `/go-accounts` or `oc-go-multi-auth list`. If the account is listed, connect OpenCode Go with the **Go API key** method and the same key. Do not run **Add Go Account** again: each run is a separate authorization and adds a duplicate account.
