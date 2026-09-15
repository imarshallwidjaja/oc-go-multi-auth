# Account Management

On OpenCode V1, add Go accounts from the auth settings. On V1 or V2, manage stored accounts with the `oc-go-multi-auth` CLI.

---

## Overview

The plugin provides these auth methods in OpenCode V1 1.18.29+:

| Method | What it does |
|---|---|
| **Add Go Account** | Add a new Go API key to the pool |
| **Set Go Account Role** | Change an existing account's preference role |

These account-management, status, and quota commands work with V1 and V2:

| Command | What it does |
|---|---|
| `oc-go-multi-auth list` | List configured accounts, roles, and enabled state |
| `oc-go-multi-auth add --key <key> [--label …] [--role …]` | Add an account from the CLI |
| `oc-go-multi-auth set-role <number> <primary\|overage_fallback>` | Set an account's preference role |
| `oc-go-multi-auth remove <number>` | Remove an account by its 1-based list number |
| `oc-go-multi-auth status` | Show account counts by role and persisted rotation state |
| `oc-go-multi-auth usage` | Query remaining Go quota windows for every stored account |
| `/go-usage` | Same report inside OpenCode |

---

## Adding an Account

### OpenCode V1 Auth Settings

1. Open OpenCode and go to **Settings → Auth**.
2. Find the **Go Multi-Auth** provider and click **Add Go Account**.
3. Enter your Go API key (from [opencode.ai/auth](https://opencode.ai/auth)).
4. Optionally enter a label (e.g., "Work account", "Personal").
5. Optionally enter a role: `primary` (default) or `overage_fallback` for a paid-overage safety-net account.
6. Confirm — you'll see a success message.

### V1 or V2 CLI

```sh
oc-go-multi-auth add --key <key> --label "Work account" --role primary
```

Restart OpenCode after changing accounts or roles. The running process keeps the account pool it loaded at startup.

### Prompt Fields

| Field | Required | Description |
|---|---|---|
| `apiKey` | Yes | Go API key starting with `go_` |
| `label` | No | Human-readable name for this account |
| `role` | No | `primary` (default) or `overage_fallback` |

### Notes

- Adding an account does **not** switch the current OpenCode process's active account. The new account will be available on the next OpenCode restart.
- Changing a role (CLI or **Set Go Account Role**) updates the on-disk pool immediately, but the live OpenCode process keeps the roles loaded at startup until restart — same as adding accounts.
- On V1, adding the first account through auth settings primes the auth store (see [authentication.md](./authentication.md) for why this matters). V2 always registers a key integration method. It redirects supported `opencode-go` catalog models and seeds a connection only when setup starts with an enabled account, so restart after adding the first account.
- Duplicate API keys are not detected — you can add the same key twice (though you probably shouldn't).

---

## Listing Accounts

Run:

```sh
oc-go-multi-auth list
```

The command prints output like:

```
  1. Work [enabled] [primary] ← current
  2. Personal [enabled] [primary]
  3. Backup [enabled] [overage_fallback]
  4. Old Account [disabled] [primary]
```

### Reading the Output

Each line shows:

- **Number** — Index in the account list (1-based).
- **Label** — The label you gave when adding the account, or "Account N" if no label was set.
- **Status** — `[enabled]` or `[disabled]` (all accounts are enabled when added; disabling is a future feature).
- **Role** — `[primary]` (preferred) or `[overage_fallback]` (paid-overage safety net). Missing roles in older files load as `primary`.
- **← current** — Indicates the persisted rotation position. Successful live failover updates it when the replacement becomes sticky.

### Setting a Role

Tag the account that has paid overages enabled:

```sh
oc-go-multi-auth set-role 3 overage_fallback
```

On V1, you can instead use **Settings → Auth → Set Go Account Role** and enter the list number plus `primary` or `overage_fallback`.

For the account count by role and raw persisted rotation values, run `oc-go-multi-auth status`.

To see remaining vs used percent for each stored account, run `oc-go-multi-auth usage` or type `/go-usage` in OpenCode. Both call `GET https://opencode.ai/zen/go/v1/usage`. An account still has usage left when every window status is `ok`. The endpoint returns the 5-hour, weekly, and monthly percent windows; it does not currently return remaining dollars.

Primaries with OpenCode Go **Use balance** enabled may spend Zen balance without producing a rotatable failure. Disable Use balance on primary accounts when you want strict overage minimization.

---

## Removing an Account

First run `oc-go-multi-auth list` to find the account's 1-based number, then remove it:

```sh
oc-go-multi-auth remove 2
```

The command removes the account immediately.

### What Happens When You Remove

- The account is spliced from the in-memory array.
- The updated list is written to `~/.config/opencode/opencode-go-accounts.json`.
- If the stored rotation index is beyond the new array bounds, it is clamped to the last available index, or 0 when the array is empty.
- **The removed API key cannot be recovered** from the plugin — add it again if needed.

---

## Account State

### Enabled / Disabled

Every account has an `enabled` boolean field. Currently all accounts are added as `enabled: true`. There is no disable/enable action in the UI yet. Disabled accounts are skipped during rotation.

### Active Account

The "active" marker starts with the account selected by round-robin at process startup. A successful live failover changes the sticky account for later requests and immediately persists that replacement as active. You cannot manually set the active account.

### Rotation Index

Tracked in `~/.config/opencode/opencode-go-rotation.json`. This is the index of the current sticky account, including a successful live failover replacement. On the next OpenCode restart, the **next** enabled account is selected:

```
OpenCode run 1: Account 1 (rotationIndex = 0)
OpenCode run 2: Account 2 (rotationIndex = 1)
OpenCode run 3: Account 3 (rotationIndex = 2)
OpenCode run 4: Account 1 (rotationIndex = 0) ← wraps around
Session 2: Account 2 (rotationIndex = 1)
Session 3: Account 3 (rotationIndex = 2)
Session 4: Account 1 (rotationIndex = 0) ← wraps around
```

---

## Example Workflows

### Adding Multiple Accounts

```sh
oc-go-multi-auth add --key <key1> --label "Work"
oc-go-multi-auth add --key <key2> --label "Personal"
oc-go-multi-auth add --key <key3> --label "Backup"
```

### Checking Which Account Is Active

```sh
oc-go-multi-auth list
# The persisted sticky account is marked with "← current".

oc-go-multi-auth status
# Prints account count and persisted rotation state.
```

### Replacing an Old Account

```sh
oc-go-multi-auth list
oc-go-multi-auth remove 3
```

Then add the replacement:

```sh
oc-go-multi-auth add --key <new-key> --label "New Backup"
```
