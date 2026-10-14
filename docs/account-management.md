# Account Management

Manage the Go account pool with `/go-accounts` inside OpenCode, or with the `oc-go-multi-auth` CLI. Both edit the same file, `~/.config/opencode/opencode-go-accounts.json`.

---

## Overview

| Where | Command | What it does |
|---|---|---|
| OpenCode 1 and 2 | `/go-accounts` | Add an account, change its role, or remove it |
| OpenCode 1 and 2 | `/go-usage` | Quota report for every stored account |
| Terminal | `oc-go-multi-auth list` | List accounts, roles, and enabled state |
| Terminal | `oc-go-multi-auth add --key <key> [--label …] [--role …]` | Add an account |
| Terminal | `oc-go-multi-auth set-role <number> <primary\|overage_fallback>` | Set an account's preference role |
| Terminal | `oc-go-multi-auth remove <number>` | Remove an account by its 1-based list number |
| Terminal | `oc-go-multi-auth status` | Show account counts by role and the last-used account |
| Terminal | `oc-go-multi-auth usage` | Same report as `/go-usage` |

On OpenCode 2, `/go-accounts` and `/go-usage` call the plugin's RPC on the connected server, so they edit the server's account file even when that server is remote. On OpenCode 1 they edit the local file directly; to manage a remote OpenCode 1 server, run the CLI on that server.

Every edit is saved immediately and applies to the running plugin after OpenCode restarts. Each command says so when it saves.

---

## `/go-accounts`

Select `/go-accounts` from slash completion or the command palette. The list starts with **Add account**, followed by one row per account:

```
Add account
1. Work  [primary]  key ...x1ab  last used
2. Personal  [primary]  key ...zz99
3. Backup  [overage_fallback]  key ...7c2d
```

- **Add account** asks for the key, an optional label, and a role chosen from a list (`primary` or `overage_fallback`). If OpenCode Go has no stored key yet, the new key is also connected (on OpenCode 1 a connection from the environment or from configuration asks you first, because a stored key may sit underneath it); see [authentication.md](./authentication.md#connecting-opencode-go).
- **Choosing an account** offers **Change role to …** and **Remove from the pool**. Removal asks for confirmation.

Rows identify accounts by a stable id rather than by position. If another process removed or reordered accounts after the list opened, an edit to a removed account fails with "That account no longer exists" and edits nothing; an account that only moved is still edited correctly. Duplicate keys are allowed; adding the same key twice in one millisecond keeps the two ids distinct. If an older account file holds two accounts with the same key and add time, `/go-accounts` rejects an edit to either by id and asks you to use the CLI with the account number. Keys appear only as `...abcd` hints.

The key field is an ordinary text prompt, so the key is visible while you type it.

---

## The CLI

```sh
oc-go-multi-auth add --key <key> --label "Work" --role primary
oc-go-multi-auth list
oc-go-multi-auth set-role 3 overage_fallback
oc-go-multi-auth remove 2
oc-go-multi-auth status
```

`list` prints:

```
  1. Work [enabled] [primary] ← last used
  2. Personal [enabled] [primary]
  3. Backup [enabled] [overage_fallback]
```

- **Number**: position in the account file (1-based). `set-role` and `remove` resolve it inside the locked edit, so it refers to the file as it is at that moment.
- **Label**: the label given when the account was added, or "Account N".
- **Status**: `[enabled]` or `[disabled]`. Accounts are added enabled; there is no disable command, but a disabled account in the file is skipped by rotation.
- **Role**: `[primary]` (preferred) or `[overage_fallback]` (paid-overage safety net). Missing roles in older files load as `primary`.
- **← last used**: the account the running plugin last recorded as sticky.

Invalid numbers and roles exit with status 1 and an error message, for example `Error: invalid account number "5". Choose 1-3`.

---

## Concurrent Edits and Damaged Files

Edits from the CLI, `/go-accounts`, and the RPC take a lock file next to the account file, re-read the file under the lock, and write it back through a temporary file. Two edits at the same time both land.

If an edit cannot get the lock within two seconds it fails with "Account file is busy" and names the lock file. The plugin never removes a lock on its own; if no edit is running (for example after a crash), delete `opencode-go-accounts.json.lock` by hand.

If the account file is not valid JSON or not an account list, edits fail with an error, save a `.bak.<timestamp>` copy, and leave the file as it is. Fix or remove the file and try again. Listings and the running plugin treat such a file as empty.

---

## Removing an Account

Removing an account deletes its entry, including the key, from the pool file. Add it again to restore it.

Removal does not disconnect OpenCode Go. A key connected to OpenCode itself (through `opencode auth login`, OpenCode's provider list, or the plugin's first-account connection) stays connected until you remove it in OpenCode's provider settings.

---

## Roles and Usage

Tag the account that has paid overages enabled:

```sh
oc-go-multi-auth set-role 3 overage_fallback
```

or choose that account in `/go-accounts` and pick **Change role to overage_fallback**.

To see remaining and used percent for each stored account, run `/go-usage` or `oc-go-multi-auth usage`. The report leads with the summed leftover percent for the 5-hour, weekly, and monthly windows across accounts whose lookup succeeded. A rate-limited window is left out of that window's sum. Both call `GET https://opencode.ai/zen/go/v1/usage`. An account still has usage left when every window status is `ok`. The endpoint returns percent windows; it does not currently return remaining dollars.

Primaries with OpenCode Go **Use balance** enabled may spend Zen balance without producing a rotatable failure. Disable Use balance on primary accounts when you want strict overage minimization.

---

## Startup Selection

At startup the plugin selects the next enabled account after the last-used one and records it in `~/.config/opencode/opencode-go-rotation.json`. Over several restarts this walks the pool:

```
OpenCode run 1: Account 1
OpenCode run 2: Account 2
OpenCode run 3: Account 3
OpenCode run 4: Account 1
```

A successful failover during a run makes the replacement sticky and records it, so the next run starts after that account. The record identifies the account by a fingerprint, so reordering the account file does not change which account comes next. You cannot set the starting account manually.
