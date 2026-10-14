// OpenCode 2 transport attribution. The host keeps its stock opencode-go
// provider, protocol and transport; these session hooks only swap the
// credential at the real transport boundary and attribute outcomes to the
// account that carried each attempt. The host's own retry loop drives rotation.
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRequestKind,
  SessionRetry,
  SessionWebSocketHandshake,
  SessionWebSocketReceive,
} from "@opencode/plugin/promise/session"
import {
  classifyErrorBody,
  classifyErrorPayload,
  classifyResponse,
  DEFAULT_INSPECTION_TIMEOUT_MS,
  MAX_CLASSIFICATION_BODY_BYTES,
  type ResponseClassification,
} from "./classification.js"
import { labelFor, type AccountPool, type AdvisoryCandidate, type Candidate, type Lease } from "./pool.js"

type CredentialFailure = "auth" | "quota"

/**
 * Per-session state that must not outlive the session's execution. The host's
 * hooks carry no cancellation signal, so the scope is ended from session events.
 */
interface SessionScope {
  readonly abort: AbortController
  /** The WebSocket exchange in flight; the host serializes them per session. */
  socket?: SocketExchange
  /**
   * Credential failure of the latest agent-loop attempt, kept until the host's
   * retry decision consumes it. Reset when the next attempt starts.
   */
  failure?: CredentialFailure
  /**
   * Accounts this session's agent-loop retry chain has failed with, whatever the
   * pool made of those failures. The chain's next attempts skip them. It ends
   * with an agent-loop success, a retry decision that stops or restarts the
   * pass, or the session itself.
   */
  readonly failed: Set<number>
}

interface HttpAttempt {
  readonly lease: Lease
  readonly scope?: SessionScope
  readonly kind: SessionRequestKind
}

interface SocketExchange {
  readonly lease: Lease
  readonly kind: SessionRequestKind
  responseID?: string
}

// Only failures from the agent loop feed the session retry decision.
const RETRIED_KINDS = new Set<SessionRequestKind>(["primary", "compaction"])
const TERMINAL_FRAME = /"type"\s*:\s*"(response\.(?:created|completed|failed|incomplete)|error)"/
// Plain identifiers only: an id with escapes or odd characters is not read from an unparsed frame.
const RESPONSE_ID = /"response"\s*:\s*\{\s*"id"\s*:\s*"([A-Za-z0-9_.:-]{1,256})"/

/**
 * Replaces an existing credential header. Requests without one are left alone:
 * the host decides which endpoints are authenticated.
 */
function applyCredential(headers: Headers, key: string) {
  let applied = false
  const authorization = headers.get("authorization")
  if (authorization !== null && /^bearer\s/i.test(authorization)) {
    headers.set("authorization", `Bearer ${key}`)
    applied = true
  }
  if (headers.has("x-api-key")) {
    headers.set("x-api-key", key)
    applied = true
  }
  return applied
}

function carriesCredential(headers: Headers, key: string) {
  return headers.get("authorization") === `Bearer ${key}` || headers.get("x-api-key") === key
}

function applyCredentialToRecord(headers: Record<string, string>, key: string) {
  let applied = false
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower === "authorization" && /^bearer\s/i.test(headers[name])) {
      headers[name] = `Bearer ${key}`
      applied = true
    } else if (lower === "x-api-key") {
      headers[name] = key
      applied = true
    }
  }
  return applied
}

type TerminalFrame =
  | { type: "response.created" | "response.completed" | "response.incomplete"; responseID?: string }
  | { type: "response.failed"; responseID?: string; payload: unknown }
  | { type: "error"; status?: number; payload: unknown }

function readTerminalFrame(frame: string): TerminalFrame | undefined {
  const type = TERMINAL_FRAME.exec(frame.slice(0, 256))?.[1] as TerminalFrame["type"] | undefined
  if (!type) return
  if (frame.length > MAX_CLASSIFICATION_BODY_BYTES) {
    // Completed responses can be large; only their id is needed.
    if (type === "response.created" || type === "response.completed") {
      return { type, responseID: RESPONSE_ID.exec(frame.slice(0, 1024))?.[1] }
    }
    return
  }
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    return
  }
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined
  const responseID = typeof response?.id === "string" ? response.id : undefined
  if (type === "error") {
    return { type, status: typeof record.status === "number" ? record.status : undefined, payload: record }
  }
  if (type === "response.failed") return { type, responseID, payload: record }
  return { type, responseID }
}

export type V2Transport = ReturnType<typeof createV2Transport>

/** Where an attempt is about to send the pool's key. */
export interface Destination {
  readonly model: SessionHttpRequest["model"]
  readonly url: string
}

export interface V2TransportOptions {
  inspectionTimeoutMs?: number
  /**
   * Whether the pool may carry requests now: with a destination, whether that
   * model's request may carry a pool key to that URL; without one, whether the
   * provider is the pool's at all (retry decisions). Checked at every request
   * boundary after the last wait, so a provider rebound to another integration
   * (such as a Console one) never receives a pool key.
   */
  authorize?: (destination?: Destination) => Promise<boolean>
}

export function createV2Transport(pool: AccountPool, options: V2TransportOptions = {}) {
  const { logger, now } = pool
  const inspectionTimeoutMs = options.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS
  const authorize = options.authorize ?? (async () => true)
  let disposed = false
  let httpAttempts = new WeakMap<Request, HttpAttempt>()
  const scopes = new Map<string, SessionScope>()

  const scopeOf = (sessionID: string) => {
    let scope = scopes.get(sessionID)
    if (!scope) {
      scope = { abort: new AbortController(), failed: new Set() }
      scopes.set(sessionID, scope)
    }
    return scope
  }

  /** True once the transport or the attempt's session has ended; nothing may be registered after that. */
  const stopped = (scope: SessionScope | undefined) => disposed || scope?.abort.signal.aborted === true

  /**
   * Whether the pool may carry the attempt, checked on both sides of the wait
   * so that whatever ended meanwhile is noticed before any state is touched.
   */
  const authorized = async (scope: SessionScope | undefined, destination?: Destination) =>
    !stopped(scope) && (await authorize(destination)) && !stopped(scope)

  /** Picks the sticky candidate, or probes it when every account is cooling. */
  const pickCandidate = (excluded?: ReadonlySet<number>): Candidate | undefined => {
    const candidate = pool.firstAvailable(now(), excluded)
    if (candidate) return candidate
    const probe = pool.probeCandidate(excluded)
    if (!probe) return
    logger("warn", "all candidates unavailable", {
      label: labelFor(pool.accounts, probe.index),
      index: probe.index,
      class: "availability",
      reason: "probe_sticky",
    })
    return probe
  }

  /**
   * The only wait before an attempt takes its account: one bounded advisory
   * lookup, made when just an overage account is usable. Hooks have no
   * cancellation signal, so it ends early with the session; when every account
   * is cooling the sticky account is probed and the host's retry delay owns any
   * wait. Resolves undefined when the attempt must not proceed. Whatever it
   * returns is only a proposal: the caller claims it, and writes the
   * credential, in one synchronous step after this wait.
   */
  const advise = async (
    scope: SessionScope | undefined,
    excluded: ReadonlySet<number> | undefined,
    destination: Destination,
  ): Promise<AdvisoryCandidate | null | undefined> => {
    const candidate = pool.firstAvailable(now(), excluded)
    if (!candidate || pool.isPrimary(candidate.index)) return null
    const tried = excluded ? new Set([...pool.advisoryAttempts(), ...excluded]) : pool.advisoryAttempts()
    let recovered: AdvisoryCandidate | null = null
    try {
      recovered = await pool.selectAdvisoryPrimary(candidate.index, tried, scope?.abort.signal ?? pool.signal)
    } catch {
      // Session ended or pool disposed while the bounded lookup ran.
    }
    return (await authorized(scope, destination)) ? recovered : undefined
  }

  /**
   * Takes the account for one attempt without waiting: the advisory proposal
   * when it still holds, else the ordinary pick. A claimed advisory primary
   * counts as its cooldown's one advisory attempt, because the host retries on
   * its own and a failed attempt must leave the fallback to carry the next one.
   */
  const reserve = (recovered: AdvisoryCandidate | null, excluded: ReadonlySet<number> | undefined): Lease | undefined => {
    const claimed = recovered && pool.claimCandidate(recovered, excluded)
    if (claimed) return claimed
    const candidate = pickCandidate(excluded)
    return candidate && pool.lease(candidate)
  }

  const settle = (
    lease: Lease,
    scope: SessionScope | undefined,
    status: number | undefined,
    classification: ResponseClassification | null,
    kind: SessionRequestKind,
  ) => {
    if (!classification) {
      if (status === 429) {
        logger("warn", "credential rotation suppressed", {
          label: labelFor(pool.accounts, lease.index),
          index: lease.index,
          status,
          class: "unknown",
          reason: "unclassified_429",
        })
      }
      return
    }
    if (classification.class === "overload") {
      logger("warn", "credential rotation suppressed", {
        label: labelFor(pool.accounts, lease.index),
        index: lease.index,
        status,
        class: classification.class,
        reason: classification.reason,
      })
      return
    }
    const outcome = pool.settlePenalty(lease, classification)
    // The failure is this attempt's own, so the agent loop's retry chain keeps it
    // however the pool settled: a concurrent attempt on the same account may have
    // recorded the penalty first, or a newer outcome such as an auxiliary
    // request's success may have replaced it. The chain must not return to an
    // account its own attempt just failed with.
    if (RETRIED_KINDS.has(kind) && scope && !stopped(scope)) {
      scope.failure = classification.class
      scope.failed.add(lease.index)
    }
    if (outcome !== "applied") return
    logger("warn", "credential penalty", {
      label: labelFor(pool.accounts, lease.index),
      index: lease.index,
      status,
      class: classification.class,
      reason: classification.reason,
      ...(classification.class === "quota"
        ? { cooldownSource: classification.cooldownSource, cooldownMs: classification.cooldownMs }
        : {}),
    })
  }

  const succeed = (lease: Lease, scope: SessionScope | undefined, status: number | undefined, kind: SessionRequestKind) => {
    pool.settleSuccess(lease, { status, class: "availability", reason: "prior_penalty" })
    // Only the agent loop's own success ends its failure chain; an auxiliary
    // request succeeding on the same account says nothing about it.
    if (RETRIED_KINDS.has(kind) && scope && !stopped(scope)) {
      scope.failure = undefined
      scope.failed.clear()
    }
  }

  return {
    async "http.request"(event: SessionHttpRequest) {
      // Agent-loop attempts own session state; auxiliary requests only use it.
      // Taken before any wait so a session that ends meanwhile is noticed.
      const retried = RETRIED_KINDS.has(event.kind)
      const scope = retried ? scopeOf(event.sessionID) : scopes.get(event.sessionID)
      const destination = { model: event.model, url: event.request.url }
      if (!(await authorized(scope, destination))) return
      if (scope) {
        if (retried) scope.failure = undefined
        // A WebSocket exchange that fell back to HTTP is abandoned without an outcome.
        if (scope.socket?.kind === event.kind) scope.socket = undefined
      }
      // Auxiliary requests are not part of the agent loop's chain and skip its exclusions.
      const excluded = retried ? scope?.failed : undefined
      const advice = await advise(scope, excluded, destination)
      // Everything from here to the credential write is synchronous.
      if (advice === undefined || stopped(scope)) return
      const lease = reserve(advice, excluded)
      if (!lease) return
      const key = lease.account.apiKey
      let headers = event.request.headers
      try {
        if (!applyCredential(headers, key)) return
      } catch {
        headers = new Headers(event.request.headers)
        if (!applyCredential(headers, key)) return
        event.request = new Request(event.request, { headers })
      }
      httpAttempts.set(event.request, { lease, scope, kind: event.kind })
    },

    async "http.response"(event: SessionHttpResponse) {
      const attempt = httpAttempts.get(event.request)
      if (!attempt || disposed) return
      httpAttempts.delete(event.request)
      // A later hook changed the credential: the outcome no longer belongs to this lease.
      if (!carriesCredential(event.request.headers, attempt.lease.account.apiKey)) return
      if (event.response.ok) {
        succeed(attempt.lease, attempt.scope, event.response.status, attempt.kind)
        return
      }
      const classification = await classifyResponse(event.response, inspectionTimeoutMs, now)
      if (disposed) return
      settle(attempt.lease, attempt.scope, event.response.status, classification, attempt.kind)
    },

    async "experimental.ws.handshake"(event: SessionWebSocketHandshake) {
      const scope = scopeOf(event.sessionID)
      const destination = { model: event.model, url: event.url }
      if (!(await authorized(scope, destination))) return
      scope.socket = undefined
      const retried = RETRIED_KINDS.has(event.kind)
      if (retried) scope.failure = undefined
      const excluded = retried ? scope.failed : undefined
      const advice = await advise(scope, excluded, destination)
      // Everything from here to the exchange registration is synchronous.
      if (advice === undefined || stopped(scope)) return
      const lease = reserve(advice, excluded)
      if (!lease) return
      if (!applyCredentialToRecord(event.headers, lease.account.apiKey)) return
      scope.socket = { lease, kind: event.kind }
    },

    "experimental.ws.receive"(event: SessionWebSocketReceive) {
      const scope = scopes.get(event.sessionID)
      const exchange = scope?.socket
      if (!scope || !exchange || exchange.kind !== event.kind || stopped(scope)) return
      const frame = readTerminalFrame(event.frame)
      if (!frame) return
      if (frame.type === "response.created") {
        exchange.responseID ??= frame.responseID
        return
      }
      scope.socket = undefined
      // Only the exchange's own response can settle it: another response's
      // terminal frame says nothing about this credential.
      const own = exchange.responseID !== undefined && frame.type !== "error" && frame.responseID === exchange.responseID
      if (frame.type === "response.completed") {
        if (own) succeed(exchange.lease, scope, undefined, event.kind)
      } else if (frame.type === "error") {
        settle(exchange.lease, scope, frame.status, classifyErrorPayload(frame.status, frame.payload, now), event.kind)
      } else if (frame.type === "response.failed" && own) {
        settle(exchange.lease, scope, undefined, classifyErrorPayload(undefined, frame.payload, now), event.kind)
      }
    },

    /**
     * Account-neutral retry policy; it never changes an account. It retries an
     * identified credential or quota failure while an account this session's
     * chain has not failed with is available, waits for the earliest cooldown
     * when every account is cooling, vetoes when every account is blocked, and
     * leaves overloads and unknown failures to the host, which keeps its own
     * attempt limit. The retry event names neither request nor kind, so a
     * failure counts as identified only when this session's latest agent-loop
     * attempt recorded one of the same class.
     */
    async retry(event: SessionRetry) {
      if (disposed) return
      const scope = scopes.get(event.sessionID)
      const failure = scope?.failure
      if (scope) scope.failure = undefined
      if (!(await authorized(scope))) return
      const classification = classifyErrorBody(event.error.status, event.error.response?.body, now)
      if (!classification || classification.class === "overload") return
      const time = now()
      if (pool.firstAvailable(time, scope?.failed)) {
        if (failure === classification.class) event.decision = { retry: true, delay: 0 }
        return
      }
      // This decision ends the pass: the next one starts with every account eligible again.
      scope?.failed.clear()
      // Accounts remain but the chain has failed with all of them: the host decides, bounded by its own attempt limit.
      if (pool.firstAvailable(time)) return
      const until = pool.earliestCooldown()
      if (until !== undefined) {
        event.decision = { retry: true, delay: Math.max(0, until - time) }
        return
      }
      event.decision = { retry: false }
    },

    /** Drops a finished session's state and ends any lookup still waiting on its behalf. */
    endSession(sessionID: string) {
      const scope = scopes.get(sessionID)
      scopes.delete(sessionID)
      scope?.abort.abort()
    },

    /** Stops this transport. The pool may be shared and is disposed by its owner. */
    dispose() {
      disposed = true
      for (const scope of scopes.values()) scope.abort.abort()
      scopes.clear()
      httpAttempts = new WeakMap()
    },
  }
}
