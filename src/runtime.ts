import { createRotatingFetch } from "./fetch.js"
import { log } from "./logger.js"
import { createAccountPool, type FetchFn } from "./pool.js"
import { selectAccount, hasAccounts } from "./rotate.js"
import { accountId, loadAccounts, loadRotationState, resolveLastUsedIndex, saveRotationState } from "./storage.js"
import type { GoAccount } from "./types.js"

// The runtime reads one account snapshot at startup; edits apply after a restart.
// It writes only the rotation hint file, never the account file.
function loadSnapshot() {
  const data = loadAccounts()
  if (!hasAccounts(data.accounts)) {
    log("warn", "rotation initialization skipped", { reason: "no enabled accounts" })
    return
  }
  const lastUsedIndex = resolveLastUsedIndex(data.accounts, loadRotationState())
  const { account, index } = selectAccount(data.accounts, lastUsedIndex)
  saveRotationState({ lastUsedIndex: index, lastUsedAccount: accountId(account) })
  log("info", "rotation active", {
    account: account.label || `account-${index}`,
    role: account.role,
    index,
    total: data.accounts.length,
  })
  return { accounts: data.accounts, lastUsedIndex, account }
}

/** Records the new sticky account against the current account file, which may have been edited since startup. */
function persistSticky(account: GoAccount) {
  const current = loadAccounts()
  const currentIndex = current.accounts.findIndex(
    (candidate) => candidate.apiKey === account.apiKey && candidate.addedAt === account.addedAt,
  )
  if (currentIndex === -1) {
    log("warn", "sticky account persistence skipped", { reason: "account_removed" })
    return
  }
  saveRotationState({ lastUsedIndex: currentIndex, lastUsedAccount: accountId(account) })
}

/** V1: a rotating fetch for the auth loader. */
export function initializeRotation(baseFetch?: FetchFn) {
  const snapshot = loadSnapshot()
  if (!snapshot) return
  const rotation = createRotatingFetch(snapshot.accounts, snapshot.lastUsedIndex, baseFetch, {
    onStickyChange: persistSticky,
  })
  return { key: snapshot.account.apiKey, ...rotation }
}

/** V2: the account pool behind the session hooks. */
export function initializeAccountPool() {
  const snapshot = loadSnapshot()
  if (!snapshot) return
  return createAccountPool(snapshot.accounts, snapshot.lastUsedIndex, { onStickyChange: persistSticky })
}
