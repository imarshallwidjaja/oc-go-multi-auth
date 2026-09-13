import { createRotatingFetch, type FetchFn } from "./fetch.js"
import { log } from "./logger.js"
import { selectAccount, hasAccounts } from "./rotate.js"
import { loadAccounts, loadRotationState, saveAccounts, saveRotationState } from "./storage.js"

export function initializeRotation(baseFetch?: FetchFn) {
  const data = loadAccounts()
  const state = loadRotationState()

  if (!hasAccounts(data.accounts)) {
    log("warn", "rotation initialization skipped", { reason: "no enabled accounts" })
    return
  }

  const { account, index } = selectAccount(data.accounts, state.lastUsedIndex)
  data.rotationIndex = index
  saveAccounts(data)
  saveRotationState({ lastUsedIndex: index })

  const rotation = createRotatingFetch(data.accounts, state.lastUsedIndex, baseFetch, {
    onStickyChange(account) {
      const current = loadAccounts()
      const currentIndex = current.accounts.findIndex(
        (candidate) => candidate.apiKey === account.apiKey && candidate.addedAt === account.addedAt,
      )
      if (currentIndex === -1) {
        log("warn", "sticky account persistence skipped", { reason: "account_removed" })
        return
      }
      current.rotationIndex = currentIndex
      saveAccounts(current)
      saveRotationState({ lastUsedIndex: currentIndex })
    },
  })

  log("info", "rotation active", {
    account: account.label || `account-${index}`,
    role: account.role,
    index,
    total: data.accounts.length,
  })

  return {
    key: account.apiKey,
    ...rotation,
  }
}
