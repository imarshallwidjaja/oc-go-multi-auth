# Account Management

Manage the Go account pool with `/go-accounts` inside OpenCode, or with the `oc-go-multi-auth` CLI. On OpenCode 1 you can also add accounts with **Add Go Account** in OpenCode's provider connect flow. On OpenCode 2, a Go API key you connect in OpenCode's own provider settings is added to the pool as well. All of them edit the same file, `~/.config/opencode/opencode-go-accounts.json`.

---

## Overview

| Where | Command | What it does |
|---|---|---|
| OpenCode 1 and 2 | `/go-accounts` | Add an account, change its role, or remove it |
| OpenCode 1 and 2 | `/go-usage` | Quota report for every stored account |
| OpenCode 1 provider connect | **Add Go Account** | Add an account and connect OpenCode Go with its key |
| OpenCode 2 provider settings | **Go Accounts** → **Add account** → **Use API key** | Connect a key in OpenCode; the plugin adds it to the pool as a `primary` account |
| Terminal | `oc-go-multi-auth list` | List accounts, roles, and enabled state |
| Terminal | `oc-go-multi-auth add --key <key> [--label …] [--role …]` | Add an account |
| Terminal | `oc-go-multi-auth set-role <number> <primary\|overage_fallback>` | Set an account's preference role |
| Terminal | `oc-go-multi-auth remove <number>` | Remove an account by its 1-based list number |
| Terminal | `oc-go-multi-auth status` | Show account counts by role and the last-used account |
| Terminal | `oc-go-multi-auth usage` | Same report as `/go-usage` |

On OpenCode 2, `/go-accounts` and `/go-usage` call the plugin's RPC on the connected server, so they edit the server's account file even when that server is remote. On OpenCode 1 they edit the local file directly. To add accounts to a remote OpenCode 1 server, use **Add Go Account** in the server's web UI or in a TUI attached to it; for role changes and removal, run the CLI on that server.

Every edit is saved immediately and applies to the running plugin after OpenCode restarts. Each command says so when it saves. **Add Go Account** completed in the web UI or the TUI applies without a restart, because OpenCode reloads its server instance after the connection.

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

## Add Go Account (OpenCode 1 provider connect)

OpenCode 1 lists two connect methods for OpenCode Go:

- **Go API key** is OpenCode's stock method. It stores one key as OpenCode's `opencode-go` connection and adds nothing to the pool.
- **Add Go Account** adds the key to the pool and connects OpenCode Go with it. The new key replaces the key OpenCode had stored for `opencode-go`; existing pool accounts are kept, including one that holds the replaced key.

**Add Go Account** asks for:

1. **Go API key**: leading and trailing spaces are trimmed.
2. **Account label**: required for this method, because OpenCode's web UI cannot submit an empty text field.
3. **Account role**: `primary` or `overage_fallback`.

These are OpenCode's generic prompts, which do not mask input, so the key is visible while you type it. The method writes nothing while you answer the prompts. After the last prompt, OpenCode starts the method's completion step, which saves the account to the pool and then stores the key as OpenCode's connection. Cancelling during the prompts, or before the completion step starts, saves nothing. Once that step has started, closing the dialog does not stop it, and the account can still be saved. The save and OpenCode's key storage are separate steps with no rollback, so if the dialog reports a failure, check the pool before retrying: see [OpenCode 1: Add Go Account fails](./authentication.md#troubleshooting). Starting the method again adds another account, even with the same key, because duplicate keys are allowed.

OpenCode runs this method through its OAuth screens, which complete immediately. The screen links to [opencode.ai/auth](https://opencode.ai/auth), where Go keys are managed, and shows a one-line status where a browser sign-in would show a confirmation code. There is no code to enter.

### From the web UI of a headless server

1. Open the server's web UI and go to **Settings** → **Providers**.
2. Choose **Connect** for **OpenCode Go**, then **Add Go Account**.
3. Enter the key, enter a label, and pick a role.

When the connection completes, OpenCode reloads its server instance, which loads the updated pool, and the web UI refreshes its provider list. No restart is needed.

Once OpenCode Go is connected, it no longer appears among the providers offered for connection. To add another account, choose **Show more providers**, then **OpenCode Go**, then **Add Go Account**, and answer the same prompts. Each account you add this way becomes OpenCode's connected key in turn; accounts added earlier stay in the pool.

### From the TUI or the command line

In the TUI, run `/connect`, choose **OpenCode Go**, then **Add Go Account**. The TUI reloads the server instance after the connection, as the web UI does.

From a terminal:

```sh
opencode auth login -p opencode-go -m "Add Go Account"
```

This runs in its own process and writes the files directly, so an OpenCode server that is already running keeps the pool it loaded. Restart that server to use the new account.

### Limits

OpenCode keeps one pending connection per provider. If two **Add Go Account** connections to the same server overlap, for example from two browser tabs, the later submission can replace the earlier one before it is saved. Only the later account is then added, and both screens still report success. Add accounts one at a time.

If the account file is busy or damaged, the method fails, nothing is saved, and OpenCode's stored key is unchanged; see [Concurrent Edits and Damaged Files](#concurrent-edits-and-damaged-files).

**Add Go Account** is an OpenCode 1 method. On OpenCode 2, add accounts with `/go-accounts`, which works against remote servers through the plugin's RPC, or connect the key in OpenCode's provider settings as described in the next section.

---

## Keys connected in OpenCode 2's provider settings

On OpenCode 2 the plugin watches the server for new OpenCode Go API keys and adds each one to the pool. Connect a key from the server's web UI:

1. Open **Settings** → **Providers** → **Go Accounts**.
2. Choose **Add account**, then **Use API key**.
3. Paste the key.

OpenCode stores the key as one of its own `opencode-go` credentials, and the plugin then adds it to the pool:

- The key becomes a `primary` account labelled with OpenCode's name for the credential, such as "OpenCode Go 2". Change the role afterwards with `/go-accounts` or the CLI.
- If any pool account already holds the same key (compared without leading and trailing spaces), the pool is left as it is. That account keeps its role, label, and enabled state, and nothing is written.
- Only API keys are added. A credential that OpenCode stores through a sign-in or another external method, and a key OpenCode reads from an environment variable, are never read.
- Only keys connected while the server runs with the plugin are added. Keys OpenCode had already stored when the server started are not added; add those with `/go-accounts` or the CLI.
- The running server keeps the pool it loaded at startup. Restart the server to rotate with the new account. The plugin's log records an `account imported` entry that says so.

The pool and OpenCode's credentials are managed separately after that. Removing the account from the pool leaves OpenCode's credential in place, and switching or removing credentials in OpenCode's settings never adds the account back. The plugin never activates, renames, or removes an OpenCode credential. Adding a key with `/go-accounts` or the CLI still allows a duplicate key; when such an add also connects OpenCode Go, the plugin finds the key already in the pool and adds nothing more.

### Limits

The plugin learns about new credentials from OpenCode's live event stream and lists OpenCode Go's credentials when it starts and again after each credential change. OpenCode offers no way to replay missed events, so a key is missed when it is connected while no server with the plugin is running, or after the event stream has failed; the log then has an `account import stopped` entry. Add a missed key with `/go-accounts` or the CLI.

Several plugin instances in one server may each see the same new key. One instance reads and adds it while the others wait, and once one instance has added it or found it already in the pool, none of them reads that credential again. Removing the account from the pool therefore stays final for every instance, including one that had not handled the credential yet, until the server restarts. The check against the pool also runs under the account file's lock, so the key is added once.

While `opencode-go` is bound to another integration, such as an OpenCode Console one, the plugin does not read new keys. It tries again at the next credential change after the provider belongs to the Go integration again.

A busy account file, or a key OpenCode could not return, is retried at the next credential change, with an `account import failed` or `account import skipped` entry in the log. A damaged account file stops imports until the server restarts, so each change does not leave another `.bak.<timestamp>` copy; see [Concurrent Edits and Damaged Files](#concurrent-edits-and-damaged-files). If OpenCode Go's credentials cannot be listed when the server starts, or the host lacks the event, integration, or connection lookups, nothing is imported during that server run, the log has an `account import unavailable` entry, and rotation itself is unaffected.

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

Edits from the CLI, `/go-accounts`, **Add Go Account**, the RPC, and the OpenCode 2 key import take a lock file next to the account file, re-read the file under the lock, and write it back through a temporary file. Two edits at the same time both land.

If an edit cannot get the lock within two seconds it fails with "Account file is busy" and names the lock file. The plugin never removes a lock on its own; if no edit is running (for example after a crash), delete `opencode-go-accounts.json.lock` by hand.

If the account file is not valid JSON or not an account list, edits fail with an error, save a `.bak.<timestamp>` copy, and leave the file as it is. Fix or remove the file and try again. Listings and the running plugin treat such a file as empty.

---

## Removing an Account

Removing an account deletes its entry, including the key, from the pool file. Add it again to restore it.

Removal does not disconnect OpenCode Go. A key connected to OpenCode itself (through `opencode auth login`, OpenCode's provider list including **Add Go Account**, OpenCode 2's provider settings, or the plugin's first-account connection) stays connected until you remove it in OpenCode's provider settings. On OpenCode 2, a removed account is not added back when its credential is switched or removed in OpenCode.

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
