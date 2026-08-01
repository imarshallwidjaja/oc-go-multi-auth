import { log } from "./logger"
import { selectAccount } from "./rotate"
import type { GoAccount } from "./types"

export interface RotatingFetchState {
  activeIndex: number
  blocked: Set<number>
  cooldownUntil: Map<number, number>
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
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
const DEFAULT_INSPECTION_TIMEOUT_MS = 1_000
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
  let cancelled = false
  const cancelClone = () => {
    cancelled = true
    void reader.cancel().catch(() => {})
  }
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    deadlineHandle = setTimeout(() => resolve(null), Math.max(0, timeoutMs))
  })
  const isJson = contentType.endsWith("/json") || contentType.endsWith("+json")
  let pendingPlaintextReason: RotationReason | null = null

  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline])
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
    return null
  } finally {
    if (deadlineHandle !== undefined) clearTimeout(deadlineHandle)
    if (!cancelled) reader.releaseLock()
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
    reason = await inspectResponseBody(response, inspectionContentType, inspectionTimeoutMs)
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
  const availabilityGenerations = accounts.map(() => 0)
  let nextRequestGeneration = 0
  let latestSuccessfulRequestGeneration = 0

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

  const fetch: FetchFn = async (input, init) => {
    const currentRequestGeneration = ++nextRequestGeneration
    const useFetch = baseFetch ?? globalThis.fetch
    if (input instanceof Request && (input.bodyUsed || input.body?.locked)) {
      throw new TypeError("Cannot replay a consumed or locked Request")
    }
    const template = new Request(input, init)
    const attempted = new Set<number>()
    let current = firstAvailable(now())

    while (!current) {
      const currentTime = now()
      const cooldownUntil = earliestCooldown()
      if (cooldownUntil !== undefined) {
        await wait(Math.max(0, cooldownUntil - currentTime), template.signal)
        current = firstAvailable(now())
        continue
      }
      current = probeCandidate()
      if (!current) throw new Error("No enabled Go accounts")
      logger("warn", "all candidates unavailable", {
        label: labelFor(accounts, current.index),
        index: current.index,
        class: "availability",
        reason: "probe_sticky",
      })
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
      attempted.add(current.index)
      const attemptGeneration = availabilityGenerations[current.index]
      const attempt = template.clone()
      const headers = new Headers(attempt.headers)
      headers.set("Authorization", `Bearer ${current.account.apiKey}`)
      const request = new Request(attempt, {
        headers,
      })

      const response = await useFetch(request)
      const classification = await classifyResponse(response, inspectionTimeoutMs, now)

      if (!classification) {
        if (response.status === 429) {
          logger("warn", "credential rotation suppressed", {
            label: labelFor(accounts, current.index),
            index: current.index,
            status: response.status,
            class: "unknown",
            reason: "unclassified_429",
          })
        }
        const successAccepted = response.ok
          && availabilityGenerations[current.index] === attemptGeneration
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

      if (classification.class === "overload") {
        logger("warn", "credential rotation suppressed", {
          label: labelFor(accounts, current.index),
          index: current.index,
          status: response.status,
          class: classification.class,
          reason: classification.reason,
        })
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

      let next = nextAvailable(current.index, attempted, now())
      if (!next) {
        logger("warn", "all candidates attempted", {
          label: labelFor(accounts, current.index),
          index: current.index,
          status: response.status,
          ...safeClassification,
        })
        while (!next) {
          const currentTime = now()
          next = firstAvailable(currentTime)
          if (next) {
            attempted.clear()
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
      discardResponse(response)
      replacementClass = classification.class
      replacementReason = classification.reason
      current = next
    }

  }

  return { fetch, state }
}
