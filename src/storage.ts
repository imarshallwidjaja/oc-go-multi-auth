import { mkdirSync, writeFileSync, renameSync, chmodSync, existsSync, readFileSync, copyFileSync } from "fs"

import { join } from "path"
import { normalizeAccountRole, type AccountsFile, type GoAccount, type RotationState } from "./types.js"

function dir() { return join(process.env.HOME ?? "/root", ".config", "opencode") }
function file() { return join(dir(), "opencode-go-accounts.json") }
function stateFile() { return join(dir(), "opencode-go-rotation.json") }
const PERMS = 0o600

function newFile(): AccountsFile {
  return { version: 1, accounts: [], rotationIndex: 0 }
}

function newState(): RotationState {
  return { lastUsedIndex: -1 }
}

function atomicWrite(path: string, data: string) {
  const d = dir()
  mkdirSync(d, { recursive: true })
  const tmp = path + ".tmp." + process.pid
  writeFileSync(tmp, data, "utf-8")
  chmodSync(tmp, PERMS)
  renameSync(tmp, path)
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

export function loadAccounts(): AccountsFile {
  const f = file()
  if (!existsSync(f)) return newFile()
  try {
    const raw = readFileSync(f, "utf-8")
    return normalizeAccountsFile(JSON.parse(raw) as AccountsFile)
  } catch {
    copyFileSync(f, f + ".bak." + Date.now())
    return newFile()
  }
}

export function saveAccounts(data: AccountsFile) {
  atomicWrite(file(), JSON.stringify(data, null, 2) + "\n")
}

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
