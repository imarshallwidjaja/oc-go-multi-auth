// Shared failure classification for every transport: the V1 fetch replay loop,
// V2 HTTP response hooks, V2 WebSocket frames and V2 retry decisions.

export type RotationReason =
  | "http_401"
  | "http_402"
  | "body_rate_limit"
  | "body_usage_limit"
  | "body_quota"
  | "body_api_key"
  | "body_authentication"
  | "body_model_access"
  | "body_overload"
export type PenaltyReason = Exclude<RotationReason, "body_overload">
export type PenaltyClassification =
  | { class: "auth"; reason: PenaltyReason }
  | {
      class: "quota"
      reason: PenaltyReason
      cooldownSource: string
      cooldownMs: number
      cooldownUntil: number
    }
export type ResponseClassification =
  | PenaltyClassification
  | { class: "overload"; reason: "body_overload" }

export const MAX_CLASSIFICATION_BODY_BYTES = 64 * 1024
export const DEFAULT_INSPECTION_TIMEOUT_MS = 1_000
export const DEFAULT_COOLDOWN_MS = 60_000
export const MAX_COOLDOWN_MS = 10 * 60_000
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
  [/\bactive opencode go subscription is required\b/i, "body_model_access"],
]

const plaintextValidationSignals = [
  /\b(?:request validation|validation failed)\b/i,
  /\b(?:required|missing) fields?\b|\bfields?\b.{0,80}\b(?:is|are) (?:required|missing)\b/i,
  /\b(?:schema|example|enumeration)\b/i,
  /\bmust (?:be|match)\b/i,
  /\bone of\b/i,
  /\bexpected (?:format|type)\b/i,
]

export function callerAbortError(signal: AbortSignal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError")
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

/**
 * A Responses `response.failed` frame nests its error under `response.error`;
 * the classifier reads `error` at the top level. Every path that classifies a
 * frame (WebSocket receive and the host's retry event) goes through this.
 */
function unwrapFailedResponse(body: Record<string, unknown>): Record<string, unknown> {
  const response = body.response
  if (body.type !== "response.failed" || typeof response !== "object" || response === null) return body
  return { error: (response as Record<string, unknown>).error }
}

/** Reads code/type/message fields from a parsed provider error body or frame. */
export function structuredJsonReason(value: unknown): RotationReason | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const body = unwrapFailedResponse(value as Record<string, unknown>)
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

function penaltyClass(reason: PenaltyReason): "auth" | "quota" {
  if (reason === "http_401" || reason === "http_402" || reason === "body_api_key"
    || reason === "body_authentication" || reason === "body_model_access") {
    return "auth"
  }
  return "quota"
}

function retryAfterCooldown(retryAfter: string | null | undefined, now: number) {
  const value = retryAfter?.trim()
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

function fromReason(
  reason: RotationReason | null,
  status: number | undefined,
  retryAfter: string | null | undefined,
  now: () => number,
): ResponseClassification | null {
  if (reason === "body_overload") {
    return status === 429 ? { class: "overload", reason } : null
  }
  if (!reason) return null
  if (penaltyClass(reason) === "auth") return { class: "auth", reason }

  const classificationTime = now()
  const cooldown = retryAfterCooldown(retryAfter, classificationTime)
  const cooldownMs = cooldown?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  return {
    class: "quota",
    reason,
    cooldownSource: cooldown?.cooldownSource ?? "default",
    cooldownMs,
    cooldownUntil: cooldown?.cooldownUntil ?? classificationTime + cooldownMs,
  }
}

/**
 * Classifies a provider HTTP response. Bodies are read from a bounded clone, so
 * the original stream stays unread for the caller; 2xx bodies are never cloned.
 */
export async function classifyResponse(
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
  return fromReason(reason, response.status, response.headers.get("retry-after"), now)
}

/**
 * Classifies an error the host already decoded, such as a retry event's status
 * and response body. Only the body is inspected: host-written messages are too
 * generic to separate quota from unknown rate limits.
 */
export function classifyErrorBody(
  status: number | undefined,
  body: string | undefined,
  now: () => number,
): ResponseClassification | null {
  if (status === 401) return { class: "auth", reason: "http_401" }
  if (status === 402) return { class: "auth", reason: "http_402" }
  if (status !== undefined && status >= 200 && status < 300) return null
  if (body === undefined || body.length > MAX_CLASSIFICATION_BODY_BYTES) return null
  const json = parsedJsonReason(body)
  const reason = json === undefined ? plaintextReason(body) : json
  return fromReason(reason, status, undefined, now)
}

/** Classifies an already-parsed provider error object, such as a WebSocket error frame. */
export function classifyErrorPayload(
  status: number | undefined,
  payload: unknown,
  now: () => number,
): ResponseClassification | null {
  if (status === 401) return { class: "auth", reason: "http_401" }
  if (status === 402) return { class: "auth", reason: "http_402" }
  return fromReason(structuredJsonReason(payload), status, undefined, now)
}
