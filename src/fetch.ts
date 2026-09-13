import { log } from "./logger.js"
import { USAGE_URL } from "./opencode.js"
import { selectAccount } from "./rotate.js"
import type { GoAccount } from "./types.js"

export interface RotatingFetchState {
  activeIndex: number
  blocked: Set<number>
  cooldownUntil: Map<number, number>
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Candidate = { account: GoAccount; index: number }
type Logger = typeof log
type WaitFn = (delayMs: number, signal: AbortSignal) => Promise<void>
type RotationReason =
  | "http_401"
  | "http_402"
  | "body_rate_limit"
  | "body_usage_limit"
  | "body_quota"
  | "body_api_key"
  | "body_authentication"
  | "body_model_access"
  | "body_overload"
type PreferenceReason = "preference_demotion"
type PenaltyClass = "auth" | "quota"
type PenaltyReason = Exclude<RotationReason, "body_overload">
type ResponseClassification =
  | { class: "auth"; reason: PenaltyReason }
  | {
      class: "quota"
      reason: PenaltyReason
      cooldownSource: string
      cooldownMs: number
      cooldownUntil: number
    }
  | { class: "overload"; reason: "body_overload" }

interface RotatingFetchOptions {
  logger?: Logger
  onStickyChange?: (account: GoAccount) => void
  inspectionTimeoutMs?: number
  now?: () => number
  wait?: WaitFn
}

const MAX_CLASSIFICATION_BODY_BYTES = 64 * 1024
const MAX_USAGE_BODY_BYTES = 8 * 1024
const DEFAULT_INSPECTION_TIMEOUT_MS = 1_000
const USAGE_LOOKUP_TIMEOUT_MS = 750
const USAGE_CACHE_TTL_MS = 5_000
const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 10 * 60_000
const HTTP_DATE_PATTERN = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/

const discriminatorReasons = new Map<string, RotationReason>([
  ["authentication_error", "body_authentication"],
  ["invalid_api_key", "body_api_key"],
  ["incorrect_api_key", "body_api_key"],
  ["api_key_invalid", "body_api_key"],
  ["rate_limit_error", "body_rate_limit"],
  ["rate_limit_exceeded", "body_rate_limit"],
  ["insufficient_quota", "body_quota"],
  ["quota_exceeded", "body_quota"],
  ["usage_limit_reached", "body_usage_limit"],
  ["usage_limit_exceeded", "body_usage_limit"],
  ["entitlement_required", "body_model_access"],
  ["model_access_denied", "body_model_access"],
  ["model_not_entitled", "body_model_access"],
  ["overloaded_error", "body_overload"],
  ["engine_overloaded", "body_overload"],
  ["capacity_error", "body_overload"],
])

const nonRotatableDiscriminators = new Set([
  "invalid_request",
  "invalid_request_error",
  "request_validation_error",
  "validation_error",
])

const messageSignals: Array<[RegExp, RotationReason]> = [
  [/\b(?:overload(?:ed)?|at capacity|capacity (?:exceeded|reached|unavailable))\b/i, "body_overload"],
  [/\brate[ -]limit exceeded\b/i, "body_rate_limit"],
  [/\brate[ -]limited\b/i, "body_rate_limit"],
  [/\btoo many requests\b/i, "body_rate_limit"],
  [/\busage limit (?:reached|exceeded|exhausted)\b/i, "body_usage_limit"],
  [/\bquota (?:exceeded|exhausted)\b/i, "body_quota"],
  [/\binsufficient quota\b/i, "body_quota"],
  [/\binvalid api key\b/i, "body_api_key"],
  [/\bapi key (?:is )?(?:invalid|not valid|expired|revoked)\b/i, "body_api_key"],
  [/\bauthentication (?:failed|required)\b/i, "body_authentication"],
  [/\bfailed to authenticate\b/i, "body_authentication"],
  [/\bnot entitled to (?:access|use) this model\b/i, "body_model_access"],
  [/\bdo not have access to this model\b/i, "body_model_access"],
  [/\bentitlement required\b/i, "body_model_access"],
]

const plaintextValidationSignals = [
  /\b(?:request validation|validation failed)\b/i,
  /\b(?:required|missing) fields?\b|\bfields?\b.{0,80}\b(?:is|are) (?:required|missing)\b/i,
  /\b(?:schema|example|enumeration)\b/i,
  /\bmust (?:be|match)\b/i,
  /\bone of\b/i,
  /\bexpected (?:format|type)\b/i,
]

function labelFor(accounts: GoAccount[], index: number) {
  return accounts[index]?.label || `account-${index}`
}

function messageReason(message: string): RotationReason | null {
  return messageSignals.find(([pattern]) => pattern.test(message))?.[1] ?? null
}

function plaintextReason(message: string): RotationReason | null {
  if (plaintextValidationSignals.some((pattern) => pattern.test(message))) return null
  return messageReason(message)
}

function discriminatorReason(value: unknown): RotationReason | null {
  if (typeof value !== "string") return null
  return discriminatorReasons.get(value.toLowerCase()) ?? null
}

function isNonRotatableDiscriminator(value: unknown) {
  return typeof value === "string" && nonRotatableDiscriminators.has(value.toLowerCase())
}

function structuredJsonReason(value: unknown): RotationReason | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const error = body.error
  const errorFields = typeof error === "object" && error !== null && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null
  const discriminators = [body.code, body.type, errorFields?.code, errorFields?.type]
  if (typeof error === "string") discriminators.push(error)

  if (discriminators.some(isNonRotatableDiscriminator)) return null
  const messages = [body.message, body.description, errorFields?.message, errorFields?.description]
  if (typeof error === "string") messages.push(error)
  const messageReasons = messages.map((message) => typeof message === "string" ? messageReason(message) : null)
  if (messageReasons.includes("body_overload")) return "body_overload"

  const reasons = discriminators.map(discriminatorReason)
  if (reasons.includes("body_overload")) return "body_overload"
  for (const reason of reasons) {
    if (reason) return reason
  }

  for (const reason of messageReasons) {
    if (reason) return reason
  }
  return null
}

function parsedJsonReason(text: string): RotationReason | null | undefined {
  try {
    return structuredJsonReason(JSON.parse(text))
  } catch {
    return undefined
  }
}

async function inspectResponseBody(
  response: Response,
  contentType: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RotationReason | null> {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_CLASSIFICATION_BODY_BYTES) return null

  let clone: Response
  try {
    clone = response.clone()
  } catch {
    return null
  }

  if (!clone.body) return null
  const reader = clone.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  const cancelClone = () => {
    void reader.cancel().catch(() => {})
  }
  if (signal?.aborted) {
    cancelClone()
    try {
      reader.releaseLock()
    } catch {}
    throw callerAbortError(signal)
  }
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    deadlineHandle = setTimeout(() => resolve(null), Math.max(0, timeoutMs))
  })
  let abortReject: ((error: unknown) => void) | undefined
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        abortReject = reject
      })
    : undefined
  const onAbort = () => {
    cancelClone()
    abortReject?.(callerAbortError(signal!))
  }
  signal?.addEventListener("abort", onAbort)
  const isJson = contentType.endsWith("/json") || contentType.endsWith("+json")
  let pendingPlaintextReason: RotationReason | null = null

  try {
    while (true) {
      const result = await (aborted
        ? Promise.race([reader.read(), deadline, aborted])
        : Promise.race([reader.read(), deadline]))
      if (result === null) {
        cancelClone()
        return isJson ? null : pendingPlaintextReason
      }
      const { done, value } = result
      if (done) {
        text += decoder.decode()
        if (!isJson) return plaintextReason(text)
        const reason = parsedJsonReason(text)
        return reason === undefined ? null : reason
      }
      size += value.byteLength
      if (size >= MAX_CLASSIFICATION_BODY_BYTES) {
        cancelClone()
        return null
      }
      text += decoder.decode(value, { stream: true })
      if (isJson) {
        const reason = parsedJsonReason(text)
        if (reason !== undefined) {
          cancelClone()
          return reason
        }
      } else {
        pendingPlaintextReason = plaintextReason(text)
      }
    }
  } catch {
    if (signal?.aborted) throw callerAbortError(signal)
    return null
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (deadlineHandle !== undefined) clearTimeout(deadlineHandle)
    try {
      reader.releaseLock()
    } catch {}
  }
}

function penaltyClass(reason: PenaltyReason): PenaltyClass {
  if (reason === "http_401" || reason === "http_402" || reason === "body_api_key"
    || reason === "body_authentication" || reason === "body_model_access") {
    return "auth"
  }
  return "quota"
}

function retryAfterCooldown(response: Response, now: number) {
  const value = response.headers.get("retry-after")?.trim()
  if (!value) return null

  if (/^\d+$/.test(value)) {
    const seconds = value.replace(/^0+/, "")
    if (!seconds) return null
    const maxSeconds = String(MAX_COOLDOWN_MS / 1_000)
    const cooldownMs = seconds.length > maxSeconds.length
      || (seconds.length === maxSeconds.length && seconds > maxSeconds)
      ? MAX_COOLDOWN_MS
      : Number(seconds) * 1_000
    return {
      cooldownSource: "retry_after_seconds",
      cooldownMs,
      cooldownUntil: now + cooldownMs,
    }
  }

  if (!HTTP_DATE_PATTERN.test(value)) return null
  const date = Date.parse(value)
  if (!Number.isFinite(date) || date <= now) return null
  const cooldownUntil = Math.min(date, now + MAX_COOLDOWN_MS)
  return {
    cooldownSource: "retry_after_date",
    cooldownMs: cooldownUntil - now,
    cooldownUntil,
  }
}

async function classifyResponse(
  response: Response,
  inspectionTimeoutMs: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<ResponseClassification | null> {
  if (response.status === 401) return { class: "auth", reason: "http_401" }
  if (response.status === 402) return { class: "auth", reason: "http_402" }
  if (response.ok) return null

  const contentType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim() ?? ""
  const inspectionContentType = response.status === 429 && contentType === "" ? "text/plain" : contentType
  let reason: RotationReason | null = null
  if (inspectionContentType !== "text/event-stream"
    && (inspectionContentType.startsWith("text/") || inspectionContentType.endsWith("/json")
      || inspectionContentType.endsWith("+json"))) {
    reason = await inspectResponseBody(response, inspectionContentType, inspectionTimeoutMs, signal)
  }

  if (reason === "body_overload") {
    return response.status === 429 ? { class: "overload", reason } : null
  }
  if (!reason) return null

  const responsePenaltyClass = penaltyClass(reason)
  if (responsePenaltyClass === "auth") return { class: "auth", reason }

  const classificationTime = now()
  const retryAfter = retryAfterCooldown(response, classificationTime)
  const cooldownMs = retryAfter?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  return {
    class: "quota",
    reason,
    cooldownSource: retryAfter?.cooldownSource ?? "default",
    cooldownMs,
    cooldownUntil: retryAfter?.cooldownUntil ?? classificationTime + cooldownMs,
  }
}

function discardResponse(response: Response) {
  if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => {})
}

function waitForCooldown(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)

    signal.addEventListener("abort", onAbort)
    if (signal.aborted) onAbort()
  })
}

type UsageGuidance = { eligible: boolean; useBalance: boolean }

function isUsageWindow(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const window = value as Record<string, unknown>
  if (window.status !== "ok" && window.status !== "rate-limited") return false
  if (typeof window.usagePercent !== "number" || !Number.isFinite(window.usagePercent)) return false
  if (window.usagePercent < 0 || window.usagePercent > 100) return false
  if (typeof window.resetInSec !== "number" || !Number.isFinite(window.resetInSec)) return false
  return window.resetInSec >= 0
}

function parseUsagePayload(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (typeof body.useBalance !== "boolean") return null
  if (!isUsageWindow(body.rollingUsage) || !isUsageWindow(body.weeklyUsage) || !isUsageWindow(body.monthlyUsage)) {
    return null
  }
  return {
    useBalance: body.useBalance,
    rollingUsage: body.rollingUsage as { status: "ok" | "rate-limited" },
    weeklyUsage: body.weeklyUsage as { status: "ok" | "rate-limited" },
    monthlyUsage: body.monthlyUsage as { status: "ok" | "rate-limited" },
  }
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal) {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    discardResponse(response)
    return undefined
  }

  if (!response.body) return undefined
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
    return undefined
  }
  try {
    while (true) {
      if (signal.aborted) {
        cancelReader()
        return undefined
      }
      const { done, value } = await raceAbort(reader.read(), signal)
      if (signal.aborted) {
        cancelReader()
        return undefined
      }
      if (done) {
        text += decoder.decode()
        break
      }
      size += value.byteLength
      if (size > maxBytes) {
        cancelReader()
        return undefined
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    cancelReader()
    return undefined
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function readUsageGuidance(response: Response, signal: AbortSignal): Promise<UsageGuidance> {
  if (response.status !== 200) {
    discardResponse(response)
    return { eligible: false, useBalance: false }
  }
  const json = await readBoundedJson(response, MAX_USAGE_BODY_BYTES, signal)
  if (json === undefined) return { eligible: false, useBalance: false }
  const payload = parseUsagePayload(json)
  if (!payload) return { eligible: false, useBalance: false }
  const windows = [payload.rollingUsage, payload.weeklyUsage, payload.monthlyUsage]
  return {
    eligible: windows.every((window) => window.status === "ok"),
    useBalance: payload.useBalance,
  }
}

function callerAbortError(signal: AbortSignal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError")
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

export function createRotatingFetch(
  accounts: GoAccount[],
  lastIndex: number,
  baseFetch?: FetchFn,
  options: RotatingFetchOptions = {},
): { fetch: FetchFn; state: RotatingFetchState } {
  const initial = selectAccount(accounts, lastIndex)
  const state: RotatingFetchState = {
    activeIndex: initial.index,
    blocked: new Set(),
    cooldownUntil: new Map(),
  }
  const logger = options.logger ?? log
  const inspectionTimeoutMs = options.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS
  const now = options.now ?? Date.now
  const wait = options.wait ?? waitForCooldown
  const useFetch = baseFetch ?? globalThis.fetch
  const availabilityGenerations = accounts.map(() => 0)
  let nextRequestGeneration = 0
  let latestSuccessfulRequestGeneration = 0
  const usageCache = new Map<number, { generation: number; expiresAt: number; eligible: boolean }>()
  const usageInFlight = new Map<number, { generation: number; promise: Promise<boolean> }>()
  const useBalanceWarned = new Set<number>()

  const isAvailable = (index: number, time: number) => {
    if (!accounts[index]?.enabled || state.blocked.has(index)) return false
    const until = state.cooldownUntil.get(index)
    if (until === undefined) return true
    if (until > time) return false
    state.cooldownUntil.delete(index)
    return true
  }

  const isPrimary = (index: number) => accounts[index]?.role !== "overage_fallback"

  const nextMatching = (
    afterIndex: number,
    attempted: Set<number>,
    time: number,
    primaryOnly: boolean,
  ) => {
    for (let offset = 1; offset <= accounts.length; offset++) {
      const index = (afterIndex + offset) % accounts.length
      if (attempted.has(index) || !isAvailable(index, time)) continue
      if (primaryOnly !== isPrimary(index)) continue
      return { account: accounts[index], index }
    }
    return null
  }

  const nextAvailable = (afterIndex: number, attempted: Set<number>, time: number) =>
    nextMatching(afterIndex, attempted, time, true)
    ?? nextMatching(afterIndex, attempted, time, false)

  const firstAvailable = (time: number) => {
    const activeIndex = state.activeIndex
    if (isAvailable(activeIndex, time) && isPrimary(activeIndex)) {
      return { account: accounts[activeIndex], index: activeIndex }
    }
    const primary = nextMatching(activeIndex, new Set(), time, true)
    if (primary) return primary
    if (isAvailable(activeIndex, time)) {
      return { account: accounts[activeIndex], index: activeIndex }
    }
    return nextMatching(activeIndex, new Set(), time, false)
  }

  const earliestCooldown = () => {
    let earliest: number | undefined
    for (let index = 0; index < accounts.length; index++) {
      if (!accounts[index]?.enabled || state.blocked.has(index)) continue
      const until = state.cooldownUntil.get(index)
      if (until === undefined) continue
      if (earliest === undefined || until < earliest) earliest = until
    }
    return earliest
  }

  const probeCandidate = () => {
    const stickyIndex = state.activeIndex
    if (accounts[stickyIndex]?.enabled) {
      return { account: accounts[stickyIndex], index: stickyIndex }
    }
    for (let offset = 1; offset <= accounts.length; offset++) {
      const index = (stickyIndex + offset) % accounts.length
      if (accounts[index]?.enabled) return { account: accounts[index], index }
    }
    return null
  }

  const isCoolingPrimary = (index: number, time: number, attempted: Set<number>) => {
    if (attempted.has(index) || !isPrimary(index)) return false
    if (!accounts[index]?.enabled || state.blocked.has(index)) return false
    const until = state.cooldownUntil.get(index)
    return until !== undefined && until > time
  }

  const coolingPrimaries = (afterIndex: number, attempted: Set<number>, time: number) => {
    const result: number[] = []
    for (let offset = 1; offset <= accounts.length; offset++) {
      const index = (afterIndex + offset) % accounts.length
      if (isCoolingPrimary(index, time, attempted)) result.push(index)
    }
    return result
  }

  const isStillAdvisoryEligible = (index: number, generation: number, attempted: Set<number>) => {
    if (availabilityGenerations[index] !== generation) return false
    return isCoolingPrimary(index, now(), attempted)
  }

  const lookupUsage = async (index: number): Promise<boolean> => {
    const account = accounts[index]
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error("usage lookup timeout"))
      }, USAGE_LOOKUP_TIMEOUT_MS)
    })
    const lookup = (async () => {
      const response = await useFetch(new Request(USAGE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${account.apiKey}` },
        signal: controller.signal,
      }))
      return readUsageGuidance(response, controller.signal)
    })()
    try {
      const parsed = await Promise.race([lookup, timeout])
      if (parsed.useBalance && !useBalanceWarned.has(index)) {
        useBalanceWarned.add(index)
        logger("warn", "OpenCode Go Use balance is enabled", {
          label: labelFor(accounts, index),
          index,
        })
      }
      return parsed.eligible
    } catch {
      controller.abort()
      return false
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const getOrStartUsageLookup = (index: number) => {
    const generation = availabilityGenerations[index]
    const cached = usageCache.get(index)
    if (cached && cached.generation === generation && cached.expiresAt > now()) {
      return Promise.resolve(cached.eligible)
    }
    const inflight = usageInFlight.get(index)
    if (inflight && inflight.generation === generation) return inflight.promise

    const promise = lookupUsage(index).then((eligible) => {
      if (availabilityGenerations[index] === generation) {
        usageCache.set(index, {
          generation,
          expiresAt: now() + USAGE_CACHE_TTL_MS,
          eligible,
        })
      }
      return eligible
    }).finally(() => {
      const current = usageInFlight.get(index)
      if (current?.promise === promise) usageInFlight.delete(index)
    })
    usageInFlight.set(index, { generation, promise })
    return promise
  }

  const selectAdvisoryPrimary = async (
    afterIndex: number,
    attempted: Set<number>,
    signal: AbortSignal,
  ) => {
    if (signal.aborted) throw callerAbortError(signal)
    const candidates = coolingPrimaries(afterIndex, attempted, now())
    if (candidates.length === 0) return null
    const results = await Promise.all(candidates.map(async (index) => {
      if (signal.aborted) throw callerAbortError(signal)
      return {
        index,
        generation: availabilityGenerations[index],
        eligible: await raceAbort(getOrStartUsageLookup(index), signal),
      }
    }))
    const availablePrimary = nextMatching(afterIndex, attempted, now(), true)
    if (availablePrimary) return { account: availablePrimary.account, index: availablePrimary.index, advisory: false }
    for (const { index, generation, eligible } of results) {
      if (!eligible || !isStillAdvisoryEligible(index, generation, attempted)) continue
      return { account: accounts[index], index, advisory: true, generation }
    }
    return null
  }

  const fetch: FetchFn = async (input, init) => {
    const currentRequestGeneration = ++nextRequestGeneration
    if (input instanceof Request && (input.bodyUsed || input.body?.locked)) {
      throw new TypeError("Cannot replay a consumed or locked Request")
    }
    const template = new Request(input, init)
    if (template.signal.aborted) throw callerAbortError(template.signal)
    const attempted = new Set<number>()
    let usageConsulted = false
    let advisoryOrigin: Candidate | null = null
    let selected = firstAvailable(now())
    let initialProbe = false

    const consultIfOverage = async (candidate: Candidate) => {
      if (isPrimary(candidate.index) || usageConsulted) {
        return { account: candidate.account, index: candidate.index, advisory: false as const }
      }
      usageConsulted = true
      const recovered = await selectAdvisoryPrimary(candidate.index, attempted, template.signal)
      if (!recovered) return { account: candidate.account, index: candidate.index, advisory: false as const }
      if (recovered.advisory) advisoryOrigin = candidate
      return recovered
    }

    const consultAfterResponse = async (candidate: Candidate, response: Response) => {
      try {
        return await consultIfOverage(candidate)
      } catch (error) {
        discardResponse(response)
        throw error
      }
    }

    const isReadyToAttempt = (
      index: number,
      isAdvisory: boolean,
      generation: number | undefined,
    ) => {
      if (isAdvisory) {
        return generation !== undefined && isStillAdvisoryEligible(index, generation, attempted)
      }
      if (initialProbe && attempted.size === 0) return accounts[index]?.enabled === true
      return !attempted.has(index) && isAvailable(index, now())
    }

    while (!selected) {
      const currentTime = now()
      const cooldownUntil = earliestCooldown()
      if (cooldownUntil !== undefined) {
        await wait(Math.max(0, cooldownUntil - currentTime), template.signal)
        selected = firstAvailable(now())
        continue
      }
      selected = probeCandidate()
      if (!selected) throw new Error("No enabled Go accounts")
      initialProbe = true
      logger("warn", "all candidates unavailable", {
        label: labelFor(accounts, selected.index),
        index: selected.index,
        class: "availability",
        reason: "probe_sticky",
      })
    }

    const resolved = await consultIfOverage(selected)
    let current: Candidate = { account: resolved.account, index: resolved.index }
    let advisory = resolved.advisory
    let capturedGeneration = resolved.advisory ? resolved.generation : undefined

    const resumeAfterAdvisory = () => {
      const origin = advisoryOrigin
      advisoryOrigin = null
      advisory = false
      capturedGeneration = undefined
      if (origin && !attempted.has(origin.index) && isAvailable(origin.index, now())) {
        return origin
      }
      return nextAvailable(current.index, attempted, now())
    }

    let lastResponse: Response | undefined
    const keepResponse = (response: Response) => {
      if (lastResponse && lastResponse !== response) discardResponse(lastResponse)
      lastResponse = response
    }
    const discardLastResponse = () => {
      if (!lastResponse) return
      discardResponse(lastResponse)
      lastResponse = undefined
    }

    let replacementClass = "availability"
    let replacementReason: RotationReason | PreferenceReason | "prior_penalty" = "prior_penalty"
    if (
      current.index !== state.activeIndex
      && !isPrimary(state.activeIndex)
      && isPrimary(current.index)
    ) {
      replacementClass = "preference"
      replacementReason = "preference_demotion"
    }

    while (true) {
      if (template.signal.aborted) {
        discardLastResponse()
        throw callerAbortError(template.signal)
      }
      if (!isReadyToAttempt(current.index, advisory, capturedGeneration)) {
        try {
          let next: Candidate | null = advisory
            ? resumeAfterAdvisory()
            : nextAvailable(current.index, attempted, now())
          if (next && !isPrimary(next.index) && !usageConsulted) {
            const recovered = await consultIfOverage(next)
            current = { account: recovered.account, index: recovered.index }
            advisory = recovered.advisory
            capturedGeneration = recovered.advisory ? recovered.generation : undefined
            continue
          }
          if (next) {
            current = next
            continue
          }
          const currentTime = now()
          const cooldownUntil = earliestCooldown()
          if (cooldownUntil !== undefined) {
            await wait(Math.max(0, cooldownUntil - currentTime), template.signal)
            const recovered = firstAvailable(now())
            if (recovered) {
              attempted.clear()
              const consulted = await consultIfOverage(recovered)
              current = { account: consulted.account, index: consulted.index }
              advisory = consulted.advisory
              capturedGeneration = consulted.advisory ? consulted.generation : undefined
            }
            continue
          }
          if (lastResponse) return lastResponse
          throw new Error("No enabled Go accounts")
        } catch (error) {
          discardLastResponse()
          throw error
        }
      }

      if (template.signal.aborted) {
        discardLastResponse()
        throw callerAbortError(template.signal)
      }
      discardLastResponse()
      attempted.add(current.index)
      const attemptGeneration = availabilityGenerations[current.index]
      const attempt = template.clone()
      const headers = new Headers(attempt.headers)
      headers.set("Authorization", `Bearer ${current.account.apiKey}`)
      const request = new Request(attempt, {
        headers,
      })

      let response: Response
      try {
        response = await useFetch(request)
      } catch (error) {
        if (advisory && !template.signal.aborted) {
          const overage = resumeAfterAdvisory()
          if (overage) {
            current = overage
            continue
          }
        }
        throw error
      }
      let classification: ResponseClassification | null
      try {
        classification = await classifyResponse(
          response,
          inspectionTimeoutMs,
          now,
          template.signal,
        )
      } catch (error) {
        discardResponse(response)
        throw error
      }
      if (advisory && template.signal.aborted) {
        discardResponse(response)
        throw callerAbortError(template.signal)
      }

      if (!classification) {
        if (response.ok) {
          const successAccepted = availabilityGenerations[current.index] === attemptGeneration
          if (successAccepted) {
            availabilityGenerations[current.index]++
            state.cooldownUntil.delete(current.index)
          }
          if (successAccepted && currentRequestGeneration > latestSuccessfulRequestGeneration) {
            latestSuccessfulRequestGeneration = currentRequestGeneration
            if (state.activeIndex !== current.index) {
              const previousIndex = state.activeIndex
              state.activeIndex = current.index
              options.onStickyChange?.(current.account)
              logger("info", "sticky account replaced", {
                fromLabel: labelFor(accounts, previousIndex),
                fromIndex: previousIndex,
                toLabel: labelFor(accounts, current.index),
                toIndex: current.index,
                status: response.status,
                class: replacementClass,
                reason: replacementReason,
              })
            }
          }
          return response
        }
        if (response.status === 429) {
          logger("warn", "credential rotation suppressed", {
            label: labelFor(accounts, current.index),
            index: current.index,
            status: response.status,
            class: "unknown",
            reason: "unclassified_429",
          })
        }
        if (advisory) {
          const overage = resumeAfterAdvisory()
          if (overage) {
            keepResponse(response)
            current = overage
            continue
          }
        }
        return response
      }

      if (classification.class === "overload") {
        logger("warn", "credential rotation suppressed", {
          label: labelFor(accounts, current.index),
          index: current.index,
          status: response.status,
          class: classification.class,
          reason: classification.reason,
        })
        if (advisory) {
          const overage = resumeAfterAdvisory()
          if (overage) {
            keepResponse(response)
            current = overage
            continue
          }
        }
        return response
      }

      const safeClassification = classification.class === "quota"
        ? {
            class: classification.class,
            reason: classification.reason,
            cooldownSource: classification.cooldownSource,
            cooldownMs: classification.cooldownMs,
          }
        : { class: classification.class, reason: classification.reason }

      if (availabilityGenerations[current.index] === attemptGeneration) {
        availabilityGenerations[current.index]++
        if (classification.class === "auth") {
          state.blocked.add(current.index)
          state.cooldownUntil.delete(current.index)
        } else {
          state.cooldownUntil.set(current.index, classification.cooldownUntil)
        }
      }

      let next: Candidate | null
      if (advisory) {
        next = resumeAfterAdvisory()
      } else {
        next = nextAvailable(current.index, attempted, now())
        if (next) {
          const recovered = await consultAfterResponse(next, response)
          next = { account: recovered.account, index: recovered.index }
          advisory = recovered.advisory
          capturedGeneration = recovered.advisory ? recovered.generation : undefined
        }
      }
      if (!next) {
        logger("warn", "all candidates attempted", {
          label: labelFor(accounts, current.index),
          index: current.index,
          status: response.status,
          ...safeClassification,
        })
        let waited = false
        while (!next) {
          const currentTime = now()
          const candidate = firstAvailable(currentTime)
          if (candidate && (waited || !attempted.has(candidate.index))) {
            if (waited) attempted.clear()
            next = candidate
            const recovered = await consultAfterResponse(next, response)
            next = { account: recovered.account, index: recovered.index }
            advisory = recovered.advisory
            capturedGeneration = recovered.advisory ? recovered.generation : undefined
            break
          }
          const cooldownUntil = earliestCooldown()
          if (cooldownUntil === undefined) return response
          try {
            await wait(Math.max(0, cooldownUntil - currentTime), template.signal)
          } catch (error) {
            discardResponse(response)
            throw error
          }
          waited = true
        }
      }

      logger("warn", "credential rotation", {
        fromLabel: labelFor(accounts, current.index),
        fromIndex: current.index,
        toLabel: labelFor(accounts, next.index),
        toIndex: next.index,
        status: response.status,
        ...safeClassification,
      })
      keepResponse(response)
      replacementClass = classification.class
      replacementReason = classification.reason
      current = next
    }

  }

  return { fetch, state }
}
