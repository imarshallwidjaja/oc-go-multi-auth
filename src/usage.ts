import { USAGE_URL } from "./opencode.js"
import { loadAccounts } from "./storage.js"
import type { GoAccount } from "./types.js"

export const MAX_USAGE_BODY_BYTES = 8 * 1024
export const USAGE_COMMAND_TIMEOUT_MS = 8_000
export const GO_USAGE_COMMAND = "go-usage"
export const GO_USAGE_DESCRIPTION = "Show remaining OpenCode Go quota for stored accounts"
export const EMPTY_USAGE_MESSAGE = "No Go accounts configured."

export type UsageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type UsageWindowStatus = "ok" | "rate-limited"

export interface UsageWindow {
  status: UsageWindowStatus
  percent: number
  resetsAt: string
}

export interface UsagePayload {
  rolling: UsageWindow
  weekly: UsageWindow
  monthly: UsageWindow
  useBalance?: boolean
  balanceUsd?: number
}

export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "oversized" | "aborted" | "invalid-json" | "unavailable" }

export type AccountUsageRow =
  | { kind: "disabled"; index: number; account: GoAccount }
  | { kind: "ok"; index: number; account: GoAccount; payload: UsagePayload }
  | { kind: "error"; index: number; account: GoAccount; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function callerAbortError(signal: AbortSignal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError")
}

function isAbortError(error: unknown) {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(callerAbortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(callerAbortError(signal))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort)
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function discardResponse(response: Response) {
  if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => {})
}

function parseUsageWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) return null
  if (value.status !== "ok" && value.status !== "rate-limited") return null
  if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) return null
  if (value.percent < 0 || value.percent > 100) return null
  if (typeof value.resetsAt !== "string") return null
  if (!Number.isFinite(Date.parse(value.resetsAt))) return null
  return {
    status: value.status,
    percent: value.percent,
    resetsAt: value.resetsAt,
  }
}

function parseOptionalUsd(source: Record<string, unknown>): number | undefined {
  const balance = source.balance
  if (typeof balance === "number" && Number.isFinite(balance)) return balance
  if (isRecord(balance) && typeof balance.usd === "number" && Number.isFinite(balance.usd)) {
    return balance.usd
  }
  return undefined
}

export function parseUsagePayload(value: unknown): UsagePayload | null {
  if (!isRecord(value) || !isRecord(value.usage)) return null
  const usage = value.usage
  const rolling = parseUsageWindow(usage.rolling)
  const weekly = parseUsageWindow(usage.weekly)
  const monthly = parseUsageWindow(usage.monthly)
  if (!rolling || !weekly || !monthly) return null

  const payload: UsagePayload = { rolling, weekly, monthly }
  if (typeof value.useBalance === "boolean") payload.useBalance = value.useBalance
  const balanceUsd = parseOptionalUsd(value)
  if (balanceUsd !== undefined) payload.balanceUsd = balanceUsd
  return payload
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BoundedJsonResult> {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    discardResponse(response)
    return { ok: false, reason: "oversized" }
  }

  if (!response.body) return { ok: false, reason: "unavailable" }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  const cancelReader = () => {
    void reader.cancel().catch(() => {})
  }
  if (signal.aborted) {
    cancelReader()
    try {
      reader.releaseLock()
    } catch {}
    return { ok: false, reason: "aborted" }
  }
  try {
    while (true) {
      if (signal.aborted) {
        cancelReader()
        return { ok: false, reason: "aborted" }
      }
      const { done, value } = await raceAbort(reader.read(), signal)
      if (signal.aborted) {
        cancelReader()
        return { ok: false, reason: "aborted" }
      }
      if (done) {
        text += decoder.decode()
        break
      }
      size += value.byteLength
      if (size > maxBytes) {
        cancelReader()
        return { ok: false, reason: "oversized" }
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch (error) {
    cancelReader()
    return { ok: false, reason: signal.aborted || isAbortError(error) ? "aborted" : "unavailable" }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: "invalid-json" }
  }
}

export function accountHasRemaining(payload: UsagePayload) {
  return payload.rolling.status === "ok"
    && payload.weekly.status === "ok"
    && payload.monthly.status === "ok"
}

export function accountLabel(account: GoAccount, index: number) {
  return account.label || `Account ${index + 1}`
}

export function maskApiKey(apiKey: string) {
  return `...${apiKey.slice(-4)}`
}

function errorForStatus(status: number) {
  if (status === 401) return "unauthorized (401)"
  if (status === 403) return "subscription required (403)"
  return `HTTP ${status}`
}

function errorForBounded(reason: Exclude<BoundedJsonResult, { ok: true }>["reason"]) {
  if (reason === "oversized") return "response too large"
  if (reason === "aborted") return "timed out"
  return "invalid usage response"
}

async function queryAccountUsage(
  account: GoAccount,
  index: number,
  useFetch: UsageFetch,
  timeoutMs: number,
): Promise<AccountUsageRow> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DOMException("This operation was aborted", "AbortError"))
    }, Math.max(0, timeoutMs))
  })
  const lookup = (async (): Promise<AccountUsageRow> => {
    const response = await useFetch(new Request(USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${account.apiKey}` },
      signal: controller.signal,
    }))
    if (response.status !== 200) {
      discardResponse(response)
      return { kind: "error", index, account, error: errorForStatus(response.status) }
    }
    const json = await readBoundedJson(response, MAX_USAGE_BODY_BYTES, controller.signal)
    if (!json.ok) {
      return { kind: "error", index, account, error: errorForBounded(json.reason) }
    }
    const payload = parseUsagePayload(json.value)
    if (!payload) {
      return { kind: "error", index, account, error: "invalid usage response" }
    }
    return { kind: "ok", index, account, payload }
  })()
  void lookup.catch(() => {})
  try {
    return await Promise.race([lookup, timeout])
  } catch (error) {
    controller.abort()
    const errorText = isAbortError(error) ? "timed out" : "network error"
    return { kind: "error", index, account, error: errorText }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function collectAccountUsage(
  accounts: GoAccount[],
  options: { fetch?: UsageFetch; timeoutMs?: number } = {},
): Promise<AccountUsageRow[]> {
  const useFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? USAGE_COMMAND_TIMEOUT_MS
  const rows: AccountUsageRow[] = new Array(accounts.length)
  await Promise.all(accounts.map(async (account, index) => {
    if (!account.enabled) {
      rows[index] = { kind: "disabled", index, account }
      return
    }
    rows[index] = await queryAccountUsage(account, index, useFetch, timeoutMs)
  }))
  return rows
}

function formatReset(resetsAt: string) {
  const date = new Date(resetsAt)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`
}

function formatUsd(value: number) {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`
}

function formatWindowRow(name: string, window: UsageWindow) {
  const remaining = 100 - window.percent
  const usedText = `${window.percent}%`.padStart(4)
  const leftText = `(${remaining}% left)`.padEnd(12)
  return `   ${name.padEnd(7)} ${usedText} used  ${leftText} ${window.status.padEnd(12)} resets ${formatReset(window.resetsAt)}`
}

function formatAccountRow(row: AccountUsageRow) {
  const label = accountLabel(row.account, row.index)
  const prefix = `${row.index + 1}. ${label}  [${row.account.role}]`
  if (row.kind === "disabled") {
    return `${prefix}  disabled (not queried)`
  }
  const key = `key ${maskApiKey(row.account.apiKey)}`
  if (row.kind === "error") {
    return `${prefix}  ${key}  lookup failed\n   ${row.error}`
  }
  const headline = accountHasRemaining(row.payload) ? "remaining" : "no remaining"
  const lines = [
    `${prefix}  ${key}  ${headline}`,
    formatWindowRow("5-hour", row.payload.rolling),
    formatWindowRow("weekly", row.payload.weekly),
    formatWindowRow("monthly", row.payload.monthly),
  ]
  if (row.payload.useBalance) lines.push("   Use balance is enabled")
  if (row.payload.balanceUsd !== undefined) lines.push(`   ${formatUsd(row.payload.balanceUsd)}`)
  return lines.join("\n")
}

export function formatUsageReport(rows: AccountUsageRow[]) {
  if (rows.length === 0) return `OpenCode Go usage\n\n${EMPTY_USAGE_MESSAGE}`
  return `OpenCode Go usage\n\n${rows.map(formatAccountRow).join("\n\n")}`
}

export async function reportGoUsage(options: { fetch?: UsageFetch; timeoutMs?: number } = {}) {
  const rows = await collectAccountUsage(loadAccounts().accounts, options)
  return formatUsageReport(rows)
}
