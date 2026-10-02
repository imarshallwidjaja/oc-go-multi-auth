import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { saveAccounts } from "../storage"
import type { GoAccount } from "../types"
import {
  collectAccountUsage,
  formatAggregateUsage,
  formatUsageReport,
  parseUsagePayload,
  reportGoUsage,
} from "../usage"

const origHome = process.env.HOME
let tmpHome: string

function mk(
  apiKey: string,
  enabled = true,
  label?: string,
  role: GoAccount["role"] = "primary",
): GoAccount {
  return { apiKey, label, addedAt: Date.now(), enabled, role }
}

function usageWindow(
  status: "ok" | "rate-limited",
  percent = 12,
  resetsAt = "2026-09-15T08:00:00.000Z",
) {
  return { status, percent, resetsAt }
}

function usageBody(overrides: Record<string, unknown> = {}) {
  const usageOverride = overrides.usage && typeof overrides.usage === "object" && !Array.isArray(overrides.usage)
    ? overrides.usage as Record<string, unknown>
    : {}
  const rest = { ...overrides }
  delete rest.usage
  return {
    usage: {
      rolling: usageWindow("ok"),
      weekly: usageWindow("ok", 40, "2026-09-20T00:00:00.000Z"),
      monthly: usageWindow("ok", 90, "2026-10-01T00:00:00.000Z"),
      ...usageOverride,
    },
    ...rest,
  }
}

function usageResponse(body: unknown = usageBody(), status = 200, headers?: HeadersInit) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "go-usage-test-"))
  process.env.HOME = tmpHome
})

afterEach(() => {
  process.env.HOME = origHome
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

describe("parseUsagePayload", () => {
  it("accepts live { usage: { rolling, weekly, monthly } } with percent + resetsAt", () => {
    const payload = parseUsagePayload({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-08-13T16:27:38.287Z" },
        weekly: { status: "rate-limited", percent: 3, resetsAt: "2026-08-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 1, resetsAt: "2026-09-01T00:00:00.000Z" },
      },
    })
    expect(payload).toEqual({
      rolling: { status: "ok", percent: 12, resetsAt: "2026-08-13T16:27:38.287Z" },
      weekly: { status: "rate-limited", percent: 3, resetsAt: "2026-08-20T00:00:00.000Z" },
      monthly: { status: "ok", percent: 1, resetsAt: "2026-09-01T00:00:00.000Z" },
    })
  })

  it("tolerates extra unknown fields on the body and windows", () => {
    expect(parseUsagePayload({
      extra: "tolerated",
      usage: {
        extra: true,
        rolling: { status: "ok", percent: 0, resetsAt: "2026-09-15T08:00:00.000Z", extra: 1 },
        weekly: { status: "ok", percent: 0, resetsAt: "2026-09-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 0, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    })).not.toBeNull()
  })

  it("ignores a non-boolean useBalance and still accepts valid windows", () => {
    const payload = parseUsagePayload({
      useBalance: "yes",
      usage: {
        rolling: usageWindow("ok"),
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok"),
      },
    })
    expect(payload?.useBalance).toBeUndefined()
    expect(payload?.rolling.status).toBe("ok")
  })

  it("records boolean useBalance when present", () => {
    expect(parseUsagePayload({
      useBalance: true,
      usage: {
        rolling: usageWindow("ok"),
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok"),
      },
    })?.useBalance).toBe(true)
  })

  it("reads optional USD from numeric balance or balance.usd", () => {
    expect(parseUsagePayload({
      balance: 12,
      usage: {
        rolling: usageWindow("ok"),
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok"),
      },
    })?.balanceUsd).toBe(12)
    expect(parseUsagePayload({
      balance: { usd: 4.5 },
      usage: {
        rolling: usageWindow("ok"),
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok"),
      },
    })?.balanceUsd).toBe(4.5)
  })

  it("omits USD when balance is not a finite number", () => {
    expect(parseUsagePayload({
      balance: "12.00",
      usage: {
        rolling: usageWindow("ok"),
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok"),
      },
    })?.balanceUsd).toBeUndefined()
  })

  it("rejects missing or invalid windows", () => {
    expect(parseUsagePayload({ useBalance: false })).toBeNull()
    expect(parseUsagePayload({ usage: {} })).toBeNull()
    expect(parseUsagePayload({
      usage: {
        rolling: usageWindow("OK" as "ok"),
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok"),
      },
    })).toBeNull()
    expect(parseUsagePayload({
      usage: {
        rolling: usageWindow("ok"),
        weekly: usageWindow("ok", 101),
        monthly: usageWindow("ok"),
      },
    })).toBeNull()
    expect(parseUsagePayload({
      usage: {
        rolling: usageWindow("ok"),
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok", 10, "not-a-date"),
      },
    })).toBeNull()
    expect(parseUsagePayload({
      rollingUsage: { status: "ok", usagePercent: 12, resetInSec: 90 },
      weeklyUsage: { status: "ok", usagePercent: 12, resetInSec: 90 },
      monthlyUsage: { status: "ok", usagePercent: 12, resetInSec: 90 },
      useBalance: false,
    })).toBeNull()
  })
})

describe("formatUsageReport", () => {
  it("includes labels, roles, masked keys, remaining headlines, and window percents", () => {
    const work = mk("go_work_key_x1ab", true, "Work")
    const personal = mk("go_personal_zz99", true, "Personal")
    const unlabeled = mk("short", true)
    const old = mk("go_old_key_dead", false, "Old")
    const report = formatUsageReport([
      {
        kind: "ok",
        index: 0,
        account: work,
        payload: {
          rolling: { status: "ok", percent: 12, resetsAt: "2026-09-15T08:00:00.000Z" },
          weekly: { status: "ok", percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
          monthly: { status: "ok", percent: 90, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      },
      {
        kind: "ok",
        index: 1,
        account: personal,
        payload: {
          rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-09-15T12:00:00.000Z" },
          weekly: { status: "ok", percent: 3, resetsAt: "2026-09-20T00:00:00.000Z" },
          monthly: { status: "ok", percent: 1, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      },
      { kind: "disabled", index: 2, account: old },
      {
        kind: "ok",
        index: 3,
        account: unlabeled,
        payload: {
          rolling: { status: "ok", percent: 0, resetsAt: "2026-09-15T08:00:00.000Z" },
          weekly: { status: "ok", percent: 0, resetsAt: "2026-09-20T00:00:00.000Z" },
          monthly: { status: "ok", percent: 0, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      },
    ])

    expect(report.startsWith([
      "OpenCode Go usage",
      "",
      "Aggregate available",
      "   5-hour   188% left",
      "   weekly   257% left",
      "   monthly  209% left",
      "",
      "1. Work  [primary]  key ...x1ab  remaining",
    ].join("\n"))).toBe(true)
    expect(report).toContain("1. Work  [primary]  key ...x1ab  remaining")
    expect(report).toContain("2. Personal  [primary]  key ...zz99  no remaining")
    expect(report).toContain("3. Old  [primary]  disabled (not queried)")
    expect(report).toContain("4. Account 4  [primary]")
    expect(report).toContain("5-hour")
    expect(report).toContain("12% used")
    expect(report).toContain("(88% left)")
    expect(report).toContain("100% used")
    expect(report).toContain("(0% left)")
    expect(report).toContain("rate-limited")
    expect(report).toContain("resets 2026-09-15 08:00 UTC")
    expect(report).not.toContain("go_work_key_x1ab")
    expect(report).not.toContain("go_personal_zz99")
    expect(report).not.toContain("go_old_key_dead")
  })

  it("normalizes displayed label whitespace without exposing short keys", () => {
    const account = mk("shorter", true, " Work\n\n\t Account ")
    const report = formatUsageReport([{
      kind: "error",
      index: 0,
      account,
      error: "unauthorized (401)",
    }])

    expect(report).toContain("1. Work Account  [primary]  key ****  lookup failed")
    expect(report).not.toContain("shorter")
    expect(account.label).toBe(" Work\n\n\t Account ")
  })

  it("shows optional USD only when present on a valid payload", () => {
    const withUsd = formatUsageReport([{
      kind: "ok",
      index: 0,
      account: mk("key-aaaa", true, "Work"),
      payload: {
        rolling: { status: "ok", percent: 1, resetsAt: "2026-09-15T08:00:00.000Z" },
        weekly: { status: "ok", percent: 1, resetsAt: "2026-09-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 1, resetsAt: "2026-10-01T00:00:00.000Z" },
        balanceUsd: 12.5,
      },
    }])
    const withoutUsd = formatUsageReport([{
      kind: "ok",
      index: 0,
      account: mk("key-aaaa", true, "Work"),
      payload: {
        rolling: { status: "ok", percent: 1, resetsAt: "2026-09-15T08:00:00.000Z" },
        weekly: { status: "ok", percent: 1, resetsAt: "2026-09-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 1, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    }])
    expect(withUsd).toContain("$12.50")
    expect(withoutUsd).not.toContain("$")
  })

  it("mentions Use balance when the optional field is true", () => {
    const report = formatUsageReport([{
      kind: "ok",
      index: 0,
      account: mk("key-aaaa", true, "Work"),
      payload: {
        rolling: { status: "ok", percent: 1, resetsAt: "2026-09-15T08:00:00.000Z" },
        weekly: { status: "ok", percent: 1, resetsAt: "2026-09-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 1, resetsAt: "2026-10-01T00:00:00.000Z" },
        useBalance: true,
      },
    }])
    expect(report).toContain("Use balance is enabled")
  })

  it("prints that no Go accounts are configured for empty storage", () => {
    const report = formatUsageReport([])
    expect(report).toContain("No Go accounts configured.")
    expect(report).not.toContain("Aggregate")
    expect(report).not.toContain("no usage data")
  })

  it("sums leftover percent for ok windows and keeps one decimal when the total is not whole", () => {
    const rows = [
      {
        kind: "ok" as const,
        index: 0,
        account: mk("key-aaaa1111", true, "Work"),
        payload: {
          rolling: { status: "ok" as const, percent: 11.5, resetsAt: "2026-09-15T08:00:00.000Z" },
          weekly: { status: "rate-limited" as const, percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
          monthly: { status: "ok" as const, percent: 0, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      },
      {
        kind: "ok" as const,
        index: 1,
        account: mk("key-bbbb2222", true, "Personal"),
        payload: {
          rolling: { status: "ok" as const, percent: 0, resetsAt: "2026-09-15T08:00:00.000Z" },
          weekly: { status: "ok" as const, percent: 0, resetsAt: "2026-09-20T00:00:00.000Z" },
          monthly: { status: "ok" as const, percent: 0, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      },
    ]
    const report = formatUsageReport(rows)

    expect(report).toContain("   5-hour   188.5% left")
    expect(report).toContain("   weekly   100% left")
    expect(report).toContain("   monthly  200% left")
    expect(formatAggregateUsage(rows).title).toBe(
      "Aggregate  5-hour 188.5% left \u00b7 weekly 100% left \u00b7 monthly 200% left",
    )
    expect(report).toContain("(60% left)")
    expect(report).toContain("rate-limited")
  })

  it("shows no usage data when every stored account failed or is disabled", () => {
    const rows = [
      { kind: "disabled" as const, index: 0, account: mk("go_old_key_dead", false, "Old") },
      {
        kind: "error" as const,
        index: 1,
        account: mk("super-secret-key-zzzz", true, "Broken"),
        error: "network error",
      },
    ]
    const report = formatUsageReport(rows)
    expect(formatAggregateUsage(rows)).toMatchObject({
      value: "aggregate",
      title: "Aggregate  no usage data",
      message: "no usage data",
    })

    expect(report.startsWith([
      "OpenCode Go usage",
      "",
      "Aggregate available",
      "no usage data",
      "",
      "1. Old  [primary]  disabled (not queried)",
    ].join("\n"))).toBe(true)
    expect(report).toContain("2. Broken  [primary]  key ...zzzz  lookup failed")
    expect(report).not.toContain("0% left")
    expect(report).not.toContain("super-secret-key-zzzz")
    expect(report).not.toContain("go_old_key_dead")
  })

  it("shows per-account lookup failures without a full key", () => {
    const report = formatUsageReport([{
      kind: "error",
      index: 0,
      account: mk("super-secret-key-zzzz", true, "Broken"),
      error: "unauthorized (401)",
    }])
    expect(report).toContain("lookup failed")
    expect(report).toContain("unauthorized (401)")
    expect(report).toContain("...zzzz")
    expect(report).not.toContain("super-secret-key-zzzz")
  })
})

describe("collectAccountUsage", () => {
  it("queries enabled accounts concurrently with Bearer auth and skips disabled", async () => {
    let started = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const auth: string[] = []
    const methods: string[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      auth.push(request.headers.get("Authorization") ?? "")
      methods.push(request.method)
      started++
      if (started === 2) release()
      await gate
      return usageResponse()
    }

    const rows = await collectAccountUsage(
      [
        mk("enabled-key-aaa1", true, "Work"),
        mk("disabled-key-bbbb", false, "Old"),
        mk("enabled-key-ccc3", true, "Personal"),
      ],
      { fetch, timeoutMs: 1_000 },
    )

    expect(auth.sort()).toEqual(["Bearer enabled-key-aaa1", "Bearer enabled-key-ccc3"])
    expect(methods).toEqual(["GET", "GET"])
    expect(rows.map((row) => row.kind)).toEqual(["ok", "disabled", "ok"])
    expect(rows[1]).toMatchObject({ kind: "disabled", account: { label: "Old" } })
  })

  it("isolates per-account errors so other accounts still print", async () => {
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const authorization = request.headers.get("Authorization")
      if (authorization === "Bearer bad-key-401a") return usageResponse("unauthorized", 401)
      if (authorization === "Bearer bad-key-403b") return usageResponse("no sub", 403)
      if (authorization === "Bearer hang-key") return new Promise<Response>(() => {})
      if (authorization === "Bearer net-key") throw new TypeError("usage network down")
      if (authorization === "Bearer huge-key") {
        return usageResponse(usageBody(), 200, { "content-length": "999999" })
      }
      if (authorization === "Bearer junk-key") return usageResponse("not-json")
      return usageResponse()
    }

    const rows = await collectAccountUsage(
      [
        mk("bad-key-401a", true, "A"),
        mk("good-key-ok01", true, "B"),
        mk("bad-key-403b", true, "C"),
        mk("hang-key", true, "D"),
        mk("net-key", true, "E"),
        mk("huge-key", true, "F"),
        mk("junk-key", true, "G"),
      ],
      { fetch, timeoutMs: 30 },
    )

    expect(rows.map((row) => row.kind === "error" ? row.error : row.kind)).toEqual([
      "unauthorized (401)",
      "ok",
      "subscription required (403)",
      "timed out",
      "network error",
      "response too large",
      "invalid usage response",
    ])
  })
})

describe("reportGoUsage", () => {
  it("loads stored accounts and formats the report", async () => {
    saveAccounts({
      version: 1,
      accounts: [
        mk("stored-key-x1ab", true, "Work"),
        mk("stored-key-old1", false, "Old"),
      ],
      rotationIndex: 0,
    })
    const fetch = async () => usageResponse()
    const report = await reportGoUsage({ fetch, timeoutMs: 1_000 })
    expect(report).toContain("Aggregate available")
    expect(report).toContain("   5-hour   88% left")
    expect(report).toContain("   weekly   60% left")
    expect(report).toContain("   monthly  10% left")
    expect(report).toContain("1. Work  [primary]  key ...x1ab  remaining")
    expect(report).toContain("disabled (not queried)")
    expect(report).not.toContain("stored-key-x1ab")
  })
})
