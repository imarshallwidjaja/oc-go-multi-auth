// Account management shared by the CLI, the V1 TUI and the V2 RPC. Results are
// display-safe summaries; an API key never leaves this module except as a masked hint.
import { log } from "./logger.js"
import {
  accountId,
  loadAccounts,
  loadRotationState,
  resolveLastUsedIndex,
  updateAccounts,
} from "./storage.js"
import { parseAccountRole, type AccountRole, type AccountsFile, type GoAccount } from "./types.js"
import { accountLabel, maskApiKey } from "./usage.js"

export interface AccountSummary {
  /** Stable identity that survives reordering; see accountId(). */
  id: string
  /** 1-based position in the account file at read time. */
  number: number
  label: string
  role: AccountRole
  enabled: boolean
  keyHint: string
  /** The account the runtime last recorded as sticky. */
  lastUsed: boolean
}

/** Selects an account by CLI number or by stable id from a listing. */
export type AccountRef = { number: number; input?: string } | { id: string }

/** A rejected edit; the message is safe to show and never contains a key. */
export class AccountInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AccountInputError"
  }
}

function summarize(account: GoAccount, index: number, lastUsedIndex: number): AccountSummary {
  return {
    id: accountId(account),
    number: index + 1,
    label: accountLabel(account, index),
    role: account.role,
    enabled: account.enabled,
    keyHint: maskApiKey(account.apiKey),
    lastUsed: index === lastUsedIndex,
  }
}

function resolve(data: AccountsFile, ref: AccountRef) {
  if ("id" in ref) {
    const matches = data.accounts.flatMap((account, index) => accountId(account) === ref.id ? [index] : [])
    if (matches.length === 0) throw new AccountInputError("That account no longer exists. Reopen the account list and try again.")
    // Files written before ids were kept unique can hold two accounts with one key and add time.
    if (matches.length > 1) {
      throw new AccountInputError(
        "Several accounts share this key and add time, so this account cannot be told apart. Use the CLI with an account number.",
      )
    }
    return matches[0]
  }
  const index = ref.number - 1
  if (!Number.isInteger(ref.number) || index < 0 || index >= data.accounts.length) {
    throw new AccountInputError(
      `invalid account number "${ref.input ?? ref.number}". Choose 1-${data.accounts.length}`,
    )
  }
  return index
}

function parseRole(value: unknown): AccountRole {
  const role = parseAccountRole(value)
  if (!role) throw new AccountInputError('role must be "primary" or "overage_fallback"')
  return role
}

/** Lenient read: a corrupt account file is backed up and listed as empty. */
export function listAccounts(): AccountSummary[] {
  const data = loadAccounts()
  const lastUsedIndex = resolveLastUsedIndex(data.accounts, loadRotationState())
  return data.accounts.map((account, index) => summarize(account, index, lastUsedIndex))
}

export async function addAccount(input: { apiKey: unknown; label?: unknown; role?: unknown }) {
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : ""
  if (!apiKey) throw new AccountInputError("An API key is required.")
  if (input.label !== undefined && typeof input.label !== "string") {
    throw new AccountInputError("The label must be text.")
  }
  const label = input.label?.trim() || undefined
  const role = input.role === undefined || input.role === "" ? "primary" : parseRole(input.role)
  const { account, count } = await updateAccounts((data) => {
    // The id hashes the key and add time. Duplicate keys are allowed, so two adds
    // in one millisecond move the later one forward to keep ids unique.
    let addedAt = Date.now()
    while (data.accounts.some((existing) => existing.apiKey === apiKey && existing.addedAt === addedAt)) addedAt++
    const account: GoAccount = { apiKey, label, addedAt, enabled: true, role }
    data.accounts.push(account)
    if (data.accounts.length === 1) data.rotationIndex = 0
    return { account, count: data.accounts.length }
  })
  const summary = summarize(account, count - 1, -1)
  log("info", "add", { label: summary.label, role, count })
  return { account: summary, count }
}

export async function setAccountRole(ref: AccountRef, role: unknown) {
  const parsed = parseRole(role)
  const summary = await updateAccounts((data) => {
    const index = resolve(data, ref)
    data.accounts[index].role = parsed
    return summarize(data.accounts[index], index, -1)
  })
  log("info", "set-role", { label: summary.label, role: parsed, index: summary.number - 1 })
  return summary
}

export async function removeAccount(ref: AccountRef) {
  const summary = await updateAccounts((data) => {
    const index = resolve(data, ref)
    const [removed] = data.accounts.splice(index, 1)
    if (data.rotationIndex >= data.accounts.length) {
      data.rotationIndex = Math.max(0, data.accounts.length - 1)
    }
    return summarize(removed, index, -1)
  })
  log("info", "remove", { label: summary.label })
  return summary
}
