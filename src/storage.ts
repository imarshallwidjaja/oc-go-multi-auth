import { createHash, randomUUID } from "crypto"
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs"
import { join } from "path"
import { normalizeAccountRole, type AccountsFile, type GoAccount, type RotationState } from "./types.js"

function dir() { return join(process.env.HOME ?? "/root", ".config", "opencode") }
export function accountsPath() { return join(dir(), "opencode-go-accounts.json") }
function stateFile() { return join(dir(), "opencode-go-rotation.json") }
function lockFile() { return `${accountsPath()}.lock` }
const PERMS = 0o600
const LOCK_WAIT_MS = 2_000
const LOCK_POLL_MS = 25

export class AccountsBusyError extends Error {
  constructor(path: string) {
    super(`Account file is busy: another oc-go-multi-auth edit holds ${path}. Try again. If no edit is running, delete that lock file.`)
    this.name = "AccountsBusyError"
  }
}

export class AccountsCorruptError extends Error {
  constructor(path: string, backup: string) {
    super(`Account file ${path} is not valid; it was left unchanged and copied to ${backup}. Fix or remove it, then try again.`)
    this.name = "AccountsCorruptError"
  }
}

function newFile(): AccountsFile {
  return { version: 1, accounts: [], rotationIndex: 0 }
}

function newState(): RotationState {
  return { lastUsedIndex: -1 }
}

/** Writes through a unique 0600 temp file and renames it into place. */
function atomicWrite(path: string, data: string) {
  mkdirSync(dir(), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`
  const fd = openSync(tmp, "wx", PERMS)
  try {
    try {
      writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function normalizeAccountsFile(data: AccountsFile): AccountsFile {
  const accounts = data.accounts.map((account): GoAccount => ({
    ...account,
    role: normalizeAccountRole(account.role),
  }))
  const rotationIndex = accounts.length === 0
    ? 0
    : Math.min(Math.max(0, data.rotationIndex || 0), accounts.length - 1)
  return { ...data, accounts, rotationIndex }
}

function isAccountsFile(value: unknown): value is AccountsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const accounts = (value as { accounts?: unknown }).accounts
  return Array.isArray(accounts) && accounts.every((account) =>
    typeof account === "object" && account !== null && typeof (account as GoAccount).apiKey === "string")
}

function backup(path: string) {
  const target = `${path}.bak.${Date.now()}`
  copyFileSync(path, target)
  return target
}

/**
 * Lenient read for runtime and display paths. A corrupt file is copied to a
 * `.bak.<timestamp>` file and treated as empty; the original is not modified.
 */
export function loadAccounts(): AccountsFile {
  const f = accountsPath()
  if (!existsSync(f)) return newFile()
  try {
    const raw = readFileSync(f, "utf-8")
    return normalizeAccountsFile(JSON.parse(raw) as AccountsFile)
  } catch {
    backup(f)
    return newFile()
  }
}

/** Strict read for edits: corruption is an error, never an empty account list. */
function readAccountsForUpdate(): AccountsFile {
  const f = accountsPath()
  if (!existsSync(f)) return newFile()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(f, "utf-8"))
  } catch {
    throw new AccountsCorruptError(f, backup(f))
  }
  if (!isAccountsFile(parsed)) throw new AccountsCorruptError(f, backup(f))
  return normalizeAccountsFile(parsed)
}

/** Unlocked whole-file write. Account edits go through updateAccounts. */
export function saveAccounts(data: AccountsFile) {
  atomicWrite(accountsPath(), JSON.stringify(data, null, 2) + "\n")
}

async function acquireLock(timeoutMs: number) {
  mkdirSync(dir(), { recursive: true })
  const path = lockFile()
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const fd = openSync(path, "wx", PERMS)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n")
      } catch (error) {
        closeSync(fd)
        rmSync(path, { force: true })
        throw error
      }
      closeSync(fd)
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    // Locks are never broken by age or PID: a slow writer may still be alive.
    if (Date.now() >= deadline) throw new AccountsBusyError(path)
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
}

/**
 * Locked read-modify-write of the account file. The file is re-read under the
 * lock, so concurrent edits from the CLI, TUI and RPC never lose each other's
 * changes. The callback may throw to abort without writing.
 */
export async function updateAccounts<T>(
  mutate: (data: AccountsFile) => T,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const lock = await acquireLock(options.timeoutMs ?? LOCK_WAIT_MS)
  try {
    const data = readAccountsForUpdate()
    const result = mutate(data)
    saveAccounts(normalizeAccountsFile(data))
    return result
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Stable, non-secret account identity: a truncated hash of addedAt and the key. */
export function accountId(account: Pick<GoAccount, "apiKey" | "addedAt">) {
  return createHash("sha256").update(`oc-go-multi-auth:${account.addedAt}:${account.apiKey}`).digest("hex").slice(0, 16)
}

/** The runtime-owned rotation hint. Account edits never write it. */
export function loadRotationState(): RotationState {
  const sf = stateFile()
  if (!existsSync(sf)) return newState()
  try {
    const raw = readFileSync(sf, "utf-8")
    return JSON.parse(raw) as RotationState
  } catch {
    return newState()
  }
}

export function saveRotationState(state: RotationState) {
  atomicWrite(stateFile(), JSON.stringify(state) + "\n")
}

/**
 * Resolves the last-used account: by identity first, then by the legacy
 * `lastUsedIndex` when it is still a valid index. Returns -1 when unknown.
 */
export function resolveLastUsedIndex(accounts: GoAccount[], state: RotationState) {
  if (typeof state.lastUsedAccount === "string") {
    const index = accounts.findIndex((account) => accountId(account) === state.lastUsedAccount)
    if (index !== -1) return index
  }
  const legacy = state.lastUsedIndex
  return Number.isInteger(legacy) && legacy >= 0 && legacy < accounts.length ? legacy : -1
}
