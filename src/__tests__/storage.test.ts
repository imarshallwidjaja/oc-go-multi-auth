import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AccountInputError, addAccount, importAccount, removeAccount, setAccountRole } from "../accounts"
import {
  accountId,
  accountsPath,
  AccountsBusyError,
  AccountsCorruptError,
  loadAccounts,
  loadRotationState,
  resolveLastUsedIndex,
  saveAccounts,
  saveRotationState,
  updateAccounts,
} from "../storage"

// storage.ts calls homedir() dynamically, so overriding HOME before each test works
const origHome = process.env.HOME
let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "go-storage-test-"))
  process.env.HOME = tmpHome
})

afterEach(() => {
  process.env.HOME = origHome
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

describe("storage", () => {
  it("returns default when file does not exist", () => {
    const result = loadAccounts()
    expect(result).toEqual({ version: 1, accounts: [], rotationIndex: 0 })
  })

  it("round-trips save and load for accounts", () => {
    const data = {
      version: 1 as const,
      accounts: [{ apiKey: "sk-test", addedAt: 1000, enabled: true, role: "primary" as const }],
      rotationIndex: 0,
    }
    saveAccounts(data)
    const loaded = loadAccounts()
    expect(loaded).toEqual(data)
  })

  it("round-trips save and load for rotation state", () => {
    saveRotationState({ lastUsedIndex: 3 })
    const loaded = loadRotationState()
    expect(loaded).toEqual({ lastUsedIndex: 3 })
  })

  it("returns default rotation state when file does not exist", () => {
    const result = loadRotationState()
    expect(result).toEqual({ lastUsedIndex: -1 })
  })

  it("handles corrupt accounts file with backup", () => {
    const d = join(tmpHome, ".config", "opencode")
    mkdirSync(d, { recursive: true })
    const filePath = join(d, "opencode-go-accounts.json")
    writeFileSync(filePath, "not-json-at-all")

    const result = loadAccounts()
    expect(result).toEqual({ version: 1, accounts: [], rotationIndex: 0 })

    const files = readdirSync(d)
    expect(files.some((f) => f.startsWith("opencode-go-accounts.json.bak."))).toBe(true)
  })

  it("handles corrupt rotation state file gracefully", () => {
    const d = join(tmpHome, ".config", "opencode")
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, "opencode-go-rotation.json"), "{bad json")

    const result = loadRotationState()
    expect(result).toEqual({ lastUsedIndex: -1 })
  })

  it("normalizes missing account role to primary on load", () => {
    const d = join(tmpHome, ".config", "opencode")
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, "opencode-go-accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          { apiKey: "go_a", addedAt: 1, enabled: true },
          { apiKey: "go_b", addedAt: 2, enabled: true, role: "overage_fallback" },
          { apiKey: "go_c", addedAt: 3, enabled: true, role: "primary" },
        ],
        rotationIndex: 0,
      }),
    )

    const loaded = loadAccounts()
    expect(loaded.accounts.map((a) => a.role)).toEqual([
      "primary",
      "overage_fallback",
      "primary",
    ])
  })

  it("treats invalid account role as primary on load", () => {
    const d = join(tmpHome, ".config", "opencode")
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, "opencode-go-accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [{ apiKey: "go_a", addedAt: 1, enabled: true, role: "paid" }],
        rotationIndex: 0,
      }),
    )

    expect(loadAccounts().accounts[0].role).toBe("primary")
  })

  it("clamps out-of-range rotationIndex on load", () => {
    const d = join(tmpHome, ".config", "opencode")
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, "opencode-go-accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [{ apiKey: "go_a", addedAt: 1, enabled: true, role: "primary" }],
        rotationIndex: 99,
      }),
    )

    expect(loadAccounts().rotationIndex).toBe(0)
  })
})

describe("account edits", () => {
  const account = (apiKey: string, addedAt: number) => ({ apiKey, addedAt, enabled: true, role: "primary" as const })
  const configDir = () => join(tmpHome, ".config", "opencode")

  it("serializes concurrent edits so none is lost", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => addAccount({ apiKey: `key-${index}` })))
    expect(loadAccounts().accounts.map((a) => a.apiKey).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `key-${index}`).sort(),
    )
    expect(readdirSync(configDir()).filter((f) => f.includes(".tmp.") || f.endsWith(".lock"))).toEqual([])
  })

  it("writes the account file with owner-only permissions", async () => {
    await addAccount({ apiKey: "key-a" })
    expect(statSync(accountsPath()).mode & 0o777).toBe(0o600)
  })

  it("fails with a busy error while another edit holds the lock, and never breaks the lock", async () => {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(`${accountsPath()}.lock`, "{}")
    await expect(updateAccounts(() => {}, { timeoutMs: 60 })).rejects.toBeInstanceOf(AccountsBusyError)
    expect(readdirSync(configDir())).toContain("opencode-go-accounts.json.lock")
  })

  it("refuses to edit a corrupt file instead of replacing it with an empty list", async () => {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(accountsPath(), "{not json")
    await expect(addAccount({ apiKey: "key-secret-1" })).rejects.toBeInstanceOf(AccountsCorruptError)
    const invalid = JSON.stringify({ version: 1, accounts: "nope" })
    writeFileSync(accountsPath(), invalid)
    await expect(setAccountRole({ number: 1 }, "primary")).rejects.toBeInstanceOf(AccountsCorruptError)
    expect(readFileSync(accountsPath(), "utf-8")).toBe(invalid)
    expect(readdirSync(configDir()).filter((f) => f.endsWith(".lock"))).toEqual([])
  })

  it("aborts without writing when the edit throws", async () => {
    saveAccounts({ version: 1, accounts: [account("key-a", 1)], rotationIndex: 0 })
    const before = readFileSync(accountsPath(), "utf-8")
    await expect(updateAccounts((data) => {
      data.accounts.length = 0
      throw new Error("rejected")
    })).rejects.toThrow("rejected")
    expect(readFileSync(accountsPath(), "utf-8")).toBe(before)
  })

  it("keeps account ids unique when one key is added twice in the same millisecond", async () => {
    const realNow = Date.now
    Date.now = () => 5_000
    try {
      const first = await addAccount({ apiKey: "duplicate-key-1111", label: "first" })
      const second = await addAccount({ apiKey: "duplicate-key-1111", label: "second" })
      await addAccount({ apiKey: "other-key-2222", label: "other" })
      expect(second.account.id).not.toBe(first.account.id)
      expect(loadAccounts().accounts.map((a) => a.addedAt)).toEqual([5_000, 5_001, 5_000])

      await setAccountRole({ id: second.account.id }, "overage_fallback")
      expect(loadAccounts().accounts.map((a) => [a.label, a.role])).toEqual([
        ["first", "primary"],
        ["second", "overage_fallback"],
        ["other", "primary"],
      ])
      await removeAccount({ id: second.account.id })
      expect(loadAccounts().accounts.map((a) => a.label)).toEqual(["first", "other"])
    } finally {
      Date.now = realNow
    }
  })

  it("rejects an id shared by accounts from an older file instead of editing the first match", async () => {
    saveAccounts({
      version: 1,
      accounts: [
        { ...account("key-a", 1), label: "first" },
        { ...account("key-a", 1), label: "second" },
      ],
      rotationIndex: 0,
    })
    const before = readFileSync(accountsPath(), "utf-8")
    const id = accountId(account("key-a", 1))
    await expect(setAccountRole({ id }, "overage_fallback")).rejects.toBeInstanceOf(AccountInputError)
    await expect(removeAccount({ id })).rejects.toThrow("Several accounts share")
    expect(readFileSync(accountsPath(), "utf-8")).toBe(before)

    await setAccountRole({ number: 2 }, "overage_fallback")
    expect(loadAccounts().accounts.map((a) => a.role)).toEqual(["primary", "overage_fallback"])
  })

  it("imports a key once as a primary account and never touches an account that already holds it", async () => {
    // Existing accounts holding the key in any state, including a hand-edited padded copy and a manual duplicate.
    const existing = [
      { ...account("held-key", 1), enabled: false, label: "off" },
      { ...account(" fallback-key\n", 2), role: "overage_fallback" as const },
      account("dup-key", 3),
      account("dup-key", 4),
    ]
    saveAccounts({ version: 1, accounts: existing, rotationIndex: 2 })
    const before = readFileSync(accountsPath(), "utf-8")
    const inode = statSync(accountsPath()).ino
    for (const apiKey of ["held-key", "fallback-key", " dup-key "]) {
      expect(await importAccount({ apiKey })).toEqual({ status: "duplicate" })
    }
    // A duplicate leaves the file unwritten: every write renames a new file into place.
    expect(statSync(accountsPath()).ino).toBe(inode)
    expect(readFileSync(accountsPath(), "utf-8")).toBe(before)
    await expect(importAccount({ apiKey: "  " })).rejects.toBeInstanceOf(AccountInputError)

    // Concurrent edits of one new key. The first import takes the lock first; the
    // later imports see its account, while a manual add may still duplicate the key.
    const [first, second, manual, third] = await Promise.all([
      importAccount({ apiKey: "new-key-5555", label: " OpenCode Go 2 " }),
      importAccount({ apiKey: " new-key-5555" }),
      addAccount({ apiKey: "new-key-5555", role: "overage_fallback" }),
      importAccount({ apiKey: "new-key-5555" }),
    ])
    expect(first).toMatchObject({ status: "imported", account: { label: "OpenCode Go 2", role: "primary" } })
    expect([second, third]).toEqual([{ status: "duplicate" }, { status: "duplicate" }])
    expect(manual.account.role).toBe("overage_fallback")
    const accounts = loadAccounts().accounts
    expect(accounts.slice(0, 4)).toEqual(existing)
    expect(accounts.slice(4).map((a) => [a.apiKey, a.label, a.role, a.enabled])).toEqual([
      ["new-key-5555", "OpenCode Go 2", "primary", true],
      ["new-key-5555", undefined, "overage_fallback", true],
    ])
    expect(loadAccounts().rotationIndex).toBe(2)
  })

  it("starts the rotation hint at the first imported account", async () => {
    const result = await importAccount({ apiKey: "only-key", label: "Host" })
    expect(result).toMatchObject({ status: "imported", count: 1, account: { label: "Host", role: "primary", keyHint: "...-key" } })
    expect(loadAccounts()).toMatchObject({ rotationIndex: 0, accounts: [{ apiKey: "only-key", label: "Host", enabled: true, role: "primary" }] })
  })

  it("resolves the last-used account by identity before the legacy index", () => {
    const accounts = [account("key-a", 1), account("key-b", 2)]
    expect(accountId(accounts[0])).toMatch(/^[0-9a-f]{16}$/)
    expect(resolveLastUsedIndex(accounts, { lastUsedIndex: 0, lastUsedAccount: accountId(accounts[1]) })).toBe(1)
    expect(resolveLastUsedIndex(accounts, { lastUsedIndex: 1, lastUsedAccount: "gone" })).toBe(1)
    expect(resolveLastUsedIndex(accounts, { lastUsedIndex: 7 })).toBe(-1)
  })
})
