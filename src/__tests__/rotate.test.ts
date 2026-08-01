import { describe, it, expect } from "bun:test"
import { nextIndex, hasAccounts, selectAccount, NoEnabledAccounts } from "../rotate"
import type { GoAccount } from "../types"

const mk = (apiKey: string, enabled: boolean): GoAccount => ({
  apiKey,
  addedAt: Date.now(),
  enabled,
  role: "primary",
})

describe("nextIndex", () => {
  it("returns (last + 1) % total", () => {
    expect(nextIndex(0, 3)).toBe(1)
    expect(nextIndex(1, 3)).toBe(2)
    expect(nextIndex(2, 3)).toBe(0)
  })
})

describe("hasAccounts", () => {
  it("returns true when at least one account is enabled", () => {
    expect(hasAccounts([mk("k1", true), mk("k2", false)])).toBe(true)
  })

  it("returns false when no accounts are enabled", () => {
    expect(hasAccounts([mk("k1", false), mk("k2", false)])).toBe(false)
  })

  it("returns false for empty array", () => {
    expect(hasAccounts([])).toBe(false)
  })
})

describe("selectAccount", () => {
  it("selects next enabled account after lastIndex", () => {
    const accounts = [mk("k1", true), mk("k2", true), mk("k3", true)]
    expect(selectAccount(accounts, -1).account.apiKey).toBe("k1")
    expect(selectAccount(accounts, 0).account.apiKey).toBe("k2")
    expect(selectAccount(accounts, 1).account.apiKey).toBe("k3")
    expect(selectAccount(accounts, 2).account.apiKey).toBe("k1")
  })

  it("skips disabled accounts", () => {
    const accounts = [mk("k1", false), mk("k2", true), mk("k3", false)]
    const result = selectAccount(accounts, -1)
    expect(result.account.apiKey).toBe("k2")
    expect(result.index).toBe(1)
  })

  it("throws NoEnabledAccounts when none enabled", () => {
    expect(() => selectAccount([mk("k1", false)], -1)).toThrow(NoEnabledAccounts)
  })

  it("throws NoEnabledAccounts for empty array", () => {
    expect(() => selectAccount([], -1)).toThrow(NoEnabledAccounts)
  })
})
