import { describe, expect, it } from "bun:test"
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRequestKind,
  SessionRetry,
  SessionWebSocketHandshake,
  SessionWebSocketReceive,
} from "@opencode/plugin/promise/session"
import { createAccountPool, type FetchFn } from "../pool"
import type { GoAccount } from "../types"
import { createV2Transport, type Destination } from "../v2-transport"

const quiet = () => {}
const scope = { sessionID: "ses_1", agent: "build", model: { providerID: "opencode-go", id: "glm" } } as const

function account(apiKey: string, role: GoAccount["role"] = "primary", enabled = true): GoAccount {
  return { apiKey, addedAt: 1, enabled, role }
}

function setup(
  accounts: GoAccount[],
  options: { now?: () => number; fetch?: FetchFn; lastIndex?: number; authorize?: (destination?: Destination) => Promise<boolean> } = {},
) {
  const sticky: string[] = []
  const pool = createAccountPool(accounts, options.lastIndex ?? -1, {
    logger: quiet,
    now: options.now,
    fetch: options.fetch ?? (async () => { throw new Error("unexpected usage lookup") }),
    onStickyChange: (next) => sticky.push(next.apiKey),
  })
  const transport = createV2Transport(pool, { inspectionTimeoutMs: 100, authorize: options.authorize })
  return { pool, transport, sticky }
}

function httpRequest(
  headers: Record<string, string> = { authorization: "Bearer host-key" },
  kind: SessionRequestKind = "primary",
  sessionID: string = scope.sessionID,
) {
  return {
    ...scope,
    sessionID,
    kind,
    request: new Request("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST", headers, body: "{}" }),
  } as SessionHttpRequest
}

async function send(
  transport: ReturnType<typeof createV2Transport>,
  response: Response,
  headers?: Record<string, string>,
  kind: SessionRequestKind = "primary",
) {
  const before = httpRequest(headers, kind)
  await transport["http.request"](before)
  const after = { ...scope, kind, request: before.request, response } as SessionHttpResponse
  await transport["http.response"](after)
  return { request: before.request, response: after.response }
}

function retryEvent(
  status: number | undefined,
  body?: string,
  sessionID = scope.sessionID,
  decision: SessionRetry["decision"] = { retry: true, delay: 2_000 },
): SessionRetry {
  return {
    ...scope,
    sessionID,
    error: { type: "provider.error", message: "failed", status, ...(body === undefined ? {} : { response: { body } }) },
    attempt: 2,
    decision,
  } as SessionRetry
}

function respond(
  transport: ReturnType<typeof createV2Transport>,
  request: SessionHttpRequest,
  response: Response,
  kind: SessionRequestKind = request.kind,
) {
  return transport["http.response"]({ ...scope, sessionID: request.sessionID, kind, request: request.request, response } as SessionHttpResponse)
}

/** Starts one attempt and returns the request the host would send. */
async function begin(transport: ReturnType<typeof createV2Transport>, kind: SessionRequestKind = "primary", sessionID: string = scope.sessionID) {
  const event = httpRequest(undefined, kind, sessionID)
  await transport["http.request"](event)
  return event
}
const bearer = (event: SessionHttpRequest) => event.request.headers.get("authorization")

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const quota = () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
  status: 429,
  headers: { "content-type": "application/json", "retry-after": "30" },
})
const invalidKey = () => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), {
  status: 401,
  headers: { "content-type": "application/json" },
})

describe("V2 HTTP attribution", () => {
  it("replaces the existing bearer or x-api-key credential and leaves unauthenticated requests alone", async () => {
    const { transport } = setup([account("key-a")])
    const bearer = httpRequest()
    await transport["http.request"](bearer)
    expect(bearer.request.headers.get("authorization")).toBe("Bearer key-a")

    const anthropic = httpRequest({ "x-api-key": "host-key", "anthropic-version": "2023-06-01" })
    await transport["http.request"](anthropic)
    expect(anthropic.request.headers.get("x-api-key")).toBe("key-a")
    expect(anthropic.request.headers.get("anthropic-version")).toBe("2023-06-01")

    const none = httpRequest({ "content-type": "application/json" })
    await transport["http.request"](none)
    expect(none.request.headers.get("authorization")).toBeNull()
    expect(none.request.headers.get("x-api-key")).toBeNull()
  })

  it("cools a quota-limited account so the next host retry uses the next account", async () => {
    let time = 1_000
    const { pool, transport, sticky } = setup([account("key-a"), account("key-b")], { now: () => time })
    const failed = await send(transport, quota())
    expect(failed.request.headers.get("authorization")).toBe("Bearer key-a")
    expect(pool.state.cooldownUntil.get(0)).toBe(time + 30_000)
    // The original body stays readable for the host.
    expect(await failed.response.text()).toContain("rate_limit_error")

    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })

    const next = await send(transport, new Response("ok"))
    expect(next.request.headers.get("authorization")).toBe("Bearer key-b")
    expect(pool.state.activeIndex).toBe(1)
    expect(sticky).toEqual(["key-b"])
  })

  it("blocks an account on auth failure and vetoes retries once every account is blocked", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    await send(transport, invalidKey())
    expect(pool.state.blocked).toEqual(new Set([0]))
    const first = retryEvent(401)
    await transport.retry(first)
    expect(first.decision).toEqual({ retry: true, delay: 0 })

    const second = await send(transport, invalidKey())
    expect(second.request.headers.get("authorization")).toBe("Bearer key-b")
    const last = retryEvent(401)
    await transport.retry(last)
    expect(last.decision).toEqual({ retry: false })
  })

  it("leaves unknown 429s and overloads to the host", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    await send(transport, new Response("slow down", { status: 429, headers: { "content-type": "text/plain" } }))
    await send(transport, new Response(JSON.stringify({ error: { type: "overloaded_error" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }))
    expect(pool.state.cooldownUntil.size).toBe(0)
    expect(pool.state.blocked.size).toBe(0)

    for (const event of [retryEvent(429, "slow down"), retryEvent(429, JSON.stringify({ error: { type: "overloaded_error" } }))]) {
      await transport.retry(event)
      expect(event.decision).toEqual({ retry: true, delay: 2_000 })
    }
  })

  it("keeps the host delay for a classified failure it cannot attribute to an account", async () => {
    const { transport } = setup([account("key-a"), account("key-b")])
    const event = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(event)
    expect(event.decision).toEqual({ retry: true, delay: 2_000 })
  })

  it("does not settle when the response arrives for another Request or a later hook changed the credential", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const event = httpRequest()
    await transport["http.request"](event)
    await transport["http.response"]({ ...scope, kind: "primary", request: new Request(event.request), response: invalidKey() } as SessionHttpResponse)
    expect(pool.state.blocked.size).toBe(0)

    const changed = httpRequest()
    await transport["http.request"](changed)
    changed.request.headers.set("authorization", "Bearer someone-else")
    await transport["http.response"]({ ...scope, kind: "primary", request: changed.request, response: invalidKey() } as SessionHttpResponse)
    expect(pool.state.blocked.size).toBe(0)
  })

  it("ignores a late success for an account whose newer attempt was penalized", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const older = httpRequest()
    const newer = httpRequest()
    await transport["http.request"](older)
    await transport["http.request"](newer)
    await transport["http.response"]({ ...scope, kind: "primary", request: newer.request, response: quota() } as SessionHttpResponse)
    await transport["http.response"]({ ...scope, kind: "primary", request: older.request, response: new Response("ok") } as SessionHttpResponse)
    expect(pool.state.cooldownUntil.has(0)).toBe(true)
  })

  it("probes the sticky account without waiting when every account is cooling, and lets the host delay own the wait", async () => {
    let time = 0
    const { pool, transport } = setup([account("key-a"), account("key-b")], { now: () => time })
    await send(transport, quota())
    await send(transport, quota())
    expect(pool.state.cooldownUntil.size).toBe(2)

    const probe = await send(transport, new Response("ok"))
    expect(probe.request.headers.get("authorization")).toBe("Bearer key-a")

    await send(transport, quota())
    time = 5_000
    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    // key-a's cooldown restarted at time 0 and key-b's never ended: the earliest ends at 30s.
    expect(retry.decision).toEqual({ retry: true, delay: 25_000 })
  })

  it("prefers a primary over the sticky overage account", async () => {
    const { transport } = setup([account("key-a", "overage_fallback"), account("key-b")], { lastIndex: -1 })
    const event = httpRequest()
    await transport["http.request"](event)
    expect(event.request.headers.get("authorization")).toBe("Bearer key-b")
  })

  it("returns to a cooling primary when the bounded usage lookup reports remaining quota", async () => {
    let time = 0
    const usage = {
      usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-09-15T08:00:00.000Z" },
        weekly: { status: "ok", percent: 10, resetsAt: "2026-09-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 10, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    }
    const lookups: string[] = []
    const { transport } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      now: () => time,
      fetch: async (input) => {
        lookups.push(new Request(input).headers.get("authorization")!)
        return Response.json(usage)
      },
    })
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    const event = httpRequest()
    await transport["http.request"](event)
    expect(lookups).toEqual(["Bearer key-a"])
    expect(event.request.headers.get("authorization")).toBe("Bearer key-a")
  })

  it("stops attributing outcomes and aborts usage lookups after disposal", async () => {
    let aborted = false
    let lookupStarted = false
    const { pool, transport } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      fetch: (input) => new Promise((_, reject) => {
        lookupStarted = true
        const signal = (input as Request).signal
        signal.addEventListener("abort", () => {
          aborted = true
          reject(signal.reason)
        })
      }),
    })
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    const pending = transport["http.request"](httpRequest())
    while (!lookupStarted) await settled()
    transport.dispose()
    pool.dispose()
    await pending
    expect(aborted).toBe(true)

    await send(transport, invalidKey())
    expect(pool.state.blocked.size).toBe(0)
  })
})

describe("V2 WebSocket attribution", () => {
  function handshake(headers: Record<string, string> = { Authorization: "Bearer host-key" }, kind: SessionRequestKind = "primary") {
    return { ...scope, kind, url: "wss://opencode.ai/zen/go/v1/responses", headers } as SessionWebSocketHandshake
  }
  function receive(frame: unknown, kind: SessionRequestKind = "primary") {
    return { ...scope, kind, frame: typeof frame === "string" ? frame : JSON.stringify(frame) } as SessionWebSocketReceive
  }

  it("assigns the credential at the handshake and settles success only on the matching completed response", async () => {
    const { pool, transport, sticky } = setup([account("key-a"), account("key-b")])
    await send(transport, quota())
    const event = handshake()
    await transport["experimental.ws.handshake"](event)
    expect(event.headers).toEqual({ Authorization: "Bearer key-b" })

    transport["experimental.ws.receive"](receive({ type: "response.created", response: { id: "resp_1" } }))
    transport["experimental.ws.receive"](receive({ type: "response.output_text.delta", delta: "hi" }))
    transport["experimental.ws.receive"](receive({ type: "response.completed", response: { id: "resp_other" } }))
    expect(sticky).toEqual([])

    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive({ type: "response.created", response: { id: "resp_2" } }))
    transport["experimental.ws.receive"](receive({ type: "response.completed", response: { id: "resp_2", output: [] } }))
    expect(sticky).toEqual(["key-b"])
    expect(pool.state.activeIndex).toBe(1)
  })

  it("penalizes explicit error and failed frames", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive({ type: "error", status: 429, error: { type: "rate_limit_error", message: "Rate limit exceeded" } }))
    expect(pool.state.cooldownUntil.has(0)).toBe(true)

    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive({ type: "response.created", response: { id: "resp_3" } }))
    transport["experimental.ws.receive"](receive({ type: "response.failed", response: { id: "resp_3", error: { code: "invalid_api_key", message: "bad" } } }))
    expect(pool.state.blocked).toEqual(new Set([1]))
  })

  it("invents no penalty for malformed, incomplete or abandoned exchanges", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive('{"type":"error", truncated'))
    transport["experimental.ws.receive"](receive({ type: "response.incomplete", response: { id: "resp_4" } }))
    transport["experimental.ws.receive"](receive({ type: "error", error: { type: "rate_limit_error" } }))
    expect(pool.state.cooldownUntil.size).toBe(0)

    // Falling back to HTTP abandons the socket exchange.
    await transport["experimental.ws.handshake"](handshake())
    await transport["http.request"](httpRequest())
    transport["experimental.ws.receive"](receive({ type: "error", error: { type: "rate_limit_error" } }))
    expect(pool.state.cooldownUntil.size).toBe(0)
  })

  it("keeps an auxiliary HTTP request from abandoning the agent loop's socket exchange", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    await transport["experimental.ws.handshake"](handshake())
    await transport["http.request"](httpRequest(undefined, "title"))
    transport["experimental.ws.receive"](receive({ type: "error", error: { type: "rate_limit_error" } }))
    expect(pool.state.cooldownUntil.has(0)).toBe(true)
  })

  it("settles a failed frame only for the exchange's own response, and the retry sees the same classification", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const failed = {
      type: "response.failed",
      response: { id: "r1", error: { code: "insufficient_quota", message: "You exceeded your current quota" } },
    }
    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive({ type: "response.created", response: { id: "r1" } }))
    const frame = receive(failed)
    const original = frame.frame
    transport["experimental.ws.receive"](frame)
    expect(frame.frame).toBe(original)
    expect(pool.state.cooldownUntil.has(0)).toBe(true)

    // The host reports a failed frame with no HTTP status and, by default, no retry.
    const retry = retryEvent(undefined, original, scope.sessionID, { retry: false })
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    const next = handshake()
    await transport["experimental.ws.handshake"](next)
    expect(next.headers).toEqual({ Authorization: "Bearer key-b" })
  })

  it("ignores a failed frame for another response or without a created response", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const failed = (id: string) => ({
      type: "response.failed",
      response: { id, error: { code: "insufficient_quota", message: "quota" } },
    })
    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive({ type: "response.created", response: { id: "r1" } }))
    transport["experimental.ws.receive"](receive(failed("r2")))
    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive(failed("r3")))
    expect(pool.state.cooldownUntil.size).toBe(0)

    const retry = retryEvent(undefined, JSON.stringify(failed("r2")), scope.sessionID, { retry: false })
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: false })
  })

  it("reads only a plain id from an oversized frame", async () => {
    const { pool, transport, sticky } = setup([account("key-a"), account("key-b")])
    await send(transport, quota())
    const padding = "x".repeat(70_000)
    const big = (type: string, id: string) =>
      `{"type":"${type}","response":{"id":${JSON.stringify(id)},"output":"${padding}"}}`

    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive(big("response.created", "resp_big")))
    transport["experimental.ws.receive"](receive(big("response.completed", "resp_big")))
    expect(sticky).toEqual(["key-b"])

    await transport["experimental.ws.handshake"](handshake())
    transport["experimental.ws.receive"](receive(big("response.created", 'odd"id')))
    transport["experimental.ws.receive"](receive(big("response.completed", 'odd"id')))
    expect(pool.state.activeIndex).toBe(1)
    expect(sticky).toEqual(["key-b"])
  })

  for (const order of ["title first", "primary first"] as const) {
    it(`sends a WebSocket primary's retry to the next account whichever finishes first: ${order}`, async () => {
      const { transport } = setup([account("key-a"), account("key-b")])
      const first = handshake()
      await transport["experimental.ws.handshake"](first)
      const title = httpRequest(undefined, "title")
      await transport["http.request"](title)
      const fail = () => transport["experimental.ws.receive"](receive({ type: "error", status: 429, error: { type: "rate_limit_error", message: "Rate limit exceeded" } }))
      if (order === "title first") {
        await respond(transport, title, new Response("ok"))
        fail()
      } else {
        fail()
        await respond(transport, title, new Response("ok"))
      }
      const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
      await transport.retry(retry)
      expect(retry.decision).toEqual({ retry: true, delay: 0 })
      const next = handshake()
      await transport["experimental.ws.handshake"](next)
      expect(next.headers).toEqual({ Authorization: "Bearer key-b" })
    })
  }

  it("steers a WebSocket quota failure to another account when an auxiliary success replaced the account's state", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const first = handshake()
    await transport["experimental.ws.handshake"](first)
    expect(first.headers).toEqual({ Authorization: "Bearer key-a" })
    await send(transport, new Response("ok"), undefined, "title")
    transport["experimental.ws.receive"](receive({ type: "error", status: 429, error: { type: "rate_limit_error", message: "Rate limit exceeded" } }))
    expect(pool.state.cooldownUntil.size).toBe(0)

    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    const next = handshake()
    await transport["experimental.ws.handshake"](next)
    expect(next.headers).toEqual({ Authorization: "Bearer key-b" })
  })

  it("drops the exchange when its session ends, even while the handshake is still waiting", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let gated = false
    const { pool, transport } = setup([account("key-a"), account("key-b")], {
      authorize: async () => {
        if (gated) await gate
        return true
      },
    })
    await transport["experimental.ws.handshake"](handshake())
    transport.endSession(scope.sessionID)
    transport["experimental.ws.receive"](receive({ type: "error", error: { type: "rate_limit_error" } }))
    expect(pool.state.cooldownUntil.size).toBe(0)

    gated = true
    const late = handshake()
    const pending = transport["experimental.ws.handshake"](late)
    transport.endSession(scope.sessionID)
    release()
    await pending
    // The ended session gets no key and registers no exchange.
    expect(late.headers).toEqual({ Authorization: "Bearer host-key" })
    transport["experimental.ws.receive"](receive({ type: "error", status: 429, error: { type: "rate_limit_error" } }))
    expect(pool.state.cooldownUntil.size).toBe(0)
  })
})

describe("V2 retry attribution", () => {
  it("retries a primary failure when a concurrent request already recorded the account's penalty", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const primary = httpRequest()
    const title = httpRequest(undefined, "title")
    await transport["http.request"](primary)
    await transport["http.request"](title)
    expect(title.request.headers.get("authorization")).toBe("Bearer key-a")

    await respond(transport, title, invalidKey())
    expect(pool.state.blocked).toEqual(new Set([0]))
    await respond(transport, primary, invalidKey())
    const retry = retryEvent(401)
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
  })

  it("does the same for a quota penalty recorded first", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")], { now: () => 1_000 })
    const title = httpRequest(undefined, "title")
    const primary = httpRequest()
    await transport["http.request"](title)
    await transport["http.request"](primary)
    await respond(transport, title, quota())
    await respond(transport, primary, quota())
    expect(pool.state.cooldownUntil.get(0)).toBe(31_000)
    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
  })

  it("keeps the pool as a newer success left it but still steers the failed attempt's own retry to another account", async () => {
    const { pool, transport, sticky } = setup([account("key-a"), account("key-b")])
    const older = httpRequest()
    const newer = httpRequest()
    await transport["http.request"](older)
    await transport["http.request"](newer)
    await respond(transport, newer, new Response("ok"))
    await respond(transport, older, invalidKey())
    expect(pool.state.blocked.size).toBe(0)
    expect(pool.state.cooldownUntil.size).toBe(0)
    expect(pool.state.activeIndex).toBe(0)
    expect(sticky).toEqual([])

    // The agent loop's own attempt failed with key-a, whatever the pool made of it.
    const retry = retryEvent(401)
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    expect(bearer(await begin(transport))).toBe("Bearer key-b")
  })

  it("leaves the decision to the host once the chain has failed with every available account, then starts a new pass", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    // The first failure ends the host's retry budget without consulting the plugin.
    const first = await begin(transport)
    await respond(transport, first, invalidKey())
    expect(pool.state.blocked).toEqual(new Set([0]))

    // key-b's lease goes stale through an auxiliary success, so the pool refuses the penalty.
    const primary = await begin(transport)
    expect(bearer(primary)).toBe("Bearer key-b")
    await send(transport, new Response("ok"), undefined, "title")
    await respond(transport, primary, invalidKey())
    expect(pool.state.blocked).toEqual(new Set([0]))

    // key-b is the only account left and the chain just failed with it: nothing local to steer, so the host decides.
    const retry = retryEvent(401)
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
    // The pass restarts, so key-b is eligible again.
    expect(bearer(await begin(transport))).toBe("Bearer key-b")
  })

  it("forces a retry once per recorded failure and only for the same class", async () => {
    const { transport } = setup([account("key-a"), account("key-b"), account("key-c")])
    await send(transport, invalidKey())
    const first = retryEvent(401)
    await transport.retry(first)
    expect(first.decision).toEqual({ retry: true, delay: 0 })
    const again = retryEvent(401)
    await transport.retry(again)
    expect(again.decision).toEqual({ retry: true, delay: 2_000 })

    await send(transport, quota())
    const other = retryEvent(401)
    await transport.retry(other)
    expect(other.decision).toEqual({ retry: true, delay: 2_000 })
  })

  it("never forces a retry for an auxiliary request's failure", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    await send(transport, invalidKey(), undefined, "title")
    expect(pool.state.blocked).toEqual(new Set([0]))
    const retry = retryEvent(401)
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
  })

  it("retries on another account when an auxiliary success replaced the primary's account state first", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")], { now: () => 1_000 })
    const primary = await begin(transport)
    expect(bearer(primary)).toBe("Bearer key-a")
    // A tiny title request on the same account succeeds before the primary's quota failure arrives.
    await send(transport, new Response("ok"), undefined, "title")
    await respond(transport, primary, quota())
    expect(pool.state.cooldownUntil.size).toBe(0)

    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    expect(bearer(await begin(transport))).toBe("Bearer key-b")
  })

  const schemes = [
    ["bearer", { authorization: "Bearer host-key" }, "authorization", (key: string) => `Bearer ${key}`],
    ["x-api-key", { "x-api-key": "host-key", "anthropic-version": "2023-06-01" }, "x-api-key", (key: string) => key],
  ] as const
  for (const [name, headers, header, credential] of schemes) {
    for (const order of ["title first", "primary first"] as const) {
      it(`sends the failed primary's retry to the next account whichever finishes first: ${name}, ${order}`, async () => {
        const { transport } = setup([account("key-a"), account("key-b")], { now: () => 1_000 })
        const primary = httpRequest(headers)
        const title = httpRequest(headers, "title")
        await transport["http.request"](primary)
        await transport["http.request"](title)
        expect(primary.request.headers.get(header)).toBe(credential("key-a"))
        expect(title.request.headers.get(header)).toBe(credential("key-a"))
        if (order === "title first") {
          await respond(transport, title, new Response("ok"))
          await respond(transport, primary, quota())
        } else {
          await respond(transport, primary, quota())
          await respond(transport, title, new Response("ok"))
        }
        const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
        await transport.retry(retry)
        expect(retry.decision).toEqual({ retry: true, delay: 0 })
        const next = httpRequest(headers)
        await transport["http.request"](next)
        expect(next.request.headers.get(header)).toBe(credential("key-b"))
      })
    }
  }

  it("lets a title quota and the primary's auth failure on one account each steer independently", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")], { now: () => 1_000 })
    const primary = await begin(transport)
    await send(transport, quota(), undefined, "title")
    expect(pool.state.cooldownUntil.get(0)).toBe(31_000)
    // An auth failure cannot be covered by a quota cooldown, so the pool treats it as superseded.
    await respond(transport, primary, invalidKey())
    expect(pool.state.blocked.size).toBe(0)

    const retry = retryEvent(401)
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    expect(bearer(await begin(transport))).toBe("Bearer key-b")
  })

  it("walks the pool instead of returning to an account its own attempt failed with", async () => {
    const { transport } = setup([account("key-a"), account("key-b"), account("key-c")])
    const used: Array<string | null> = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const primary = await begin(transport)
      used.push(bearer(primary))
      // Auxiliary traffic keeps succeeding on the same account while the main request fails.
      await send(transport, new Response("ok"), undefined, "title")
      await respond(transport, primary, invalidKey())
      const retry = retryEvent(401)
      await transport.retry(retry)
      expect(retry.decision).toEqual({ retry: true, delay: 0 })
    }
    used.push(bearer(await begin(transport)))
    expect(used).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-c"])
  })

  it("keeps the chain's exclusions away from auxiliary requests and through their successes, and ends them with the agent loop's own success", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const primary = await begin(transport)
    await send(transport, new Response("ok"), undefined, "title")
    await respond(transport, primary, invalidKey())

    // Title and generate requests follow the pool's own policy.
    expect(bearer(await begin(transport, "title"))).toBe("Bearer key-a")
    expect(bearer(await begin(transport, "generate"))).toBe("Bearer key-a")
    // The agent loop's chain still skips key-a after that, then ends with its success.
    const next = await begin(transport)
    expect(bearer(next)).toBe("Bearer key-b")
    await respond(transport, next, new Response("ok"))
    expect(pool.state.activeIndex).toBe(1)

    // The chain is over: a later failure on key-b may use key-a again.
    const later = await begin(transport)
    await respond(transport, later, quota())
    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    expect(bearer(await begin(transport))).toBe("Bearer key-a")
  })

  it("waits for the earliest cooldown when every account is cooling and starts the next pass clean", async () => {
    let time = 0
    const { transport } = setup([account("key-a"), account("key-b")], { now: () => time })
    await send(transport, quota())
    await send(transport, quota())
    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 30_000 })
    time = 30_000
    // Both accounts failed the chain, yet the new pass may use the one that recovered first.
    expect(bearer(await begin(transport))).toBe("Bearer key-a")
  })

  it("never retries through a locally excluded account when every account is blocked", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    await send(transport, invalidKey())
    await send(transport, invalidKey())
    expect(pool.state.blocked).toEqual(new Set([0, 1]))
    const retry = retryEvent(401, undefined, scope.sessionID, { retry: true, delay: 2_000 })
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: false })
  })

  it("keeps sessions apart", async () => {
    const { transport } = setup([account("key-a"), account("key-b")])
    const other = httpRequest(undefined, "primary", "ses_2")
    await transport["http.request"](other)
    await respond(transport, other, invalidKey())
    const retry = retryEvent(401)
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
    const own = retryEvent(401, undefined, "ses_2")
    await transport.retry(own)
    expect(own.decision).toEqual({ retry: true, delay: 0 })
  })
})

describe("V2 advisory lookups", () => {
  const remaining = () => Response.json({
    usage: {
      rolling: { status: "ok", percent: 10, resetsAt: "2026-09-15T08:00:00.000Z" },
      weekly: { status: "ok", percent: 10, resetsAt: "2026-09-20T00:00:00.000Z" },
      monthly: { status: "ok", percent: 10, resetsAt: "2026-10-01T00:00:00.000Z" },
    },
  })
  const authorization = async (transport: ReturnType<typeof createV2Transport>, sessionID = scope.sessionID) => {
    const event = httpRequest(undefined, "primary", sessionID)
    await transport["http.request"](event)
    return event
  }

  it("tries a cooling primary once per cooldown, then lets the overage account carry the host's retries", async () => {
    let time = 0
    const lookups: string[] = []
    const { pool, transport, sticky } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      now: () => time,
      fetch: async (input) => {
        lookups.push(new Request(input).headers.get("authorization")!)
        return remaining()
      },
    })
    await send(transport, quota())
    expect(pool.state.cooldownUntil.get(0)).toBe(30_000)
    // A new turn: the failed one's chain is over.
    transport.endSession(scope.sessionID)

    const advisory = await authorization(transport)
    expect(advisory.request.headers.get("authorization")).toBe("Bearer key-a")
    await respond(transport, advisory, quota())
    const retry = retryEvent(429, JSON.stringify({ error: { type: "rate_limit_error" } }))
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })

    const overage = await authorization(transport)
    expect(overage.request.headers.get("authorization")).toBe("Bearer key-b")
    await respond(transport, overage, new Response("ok"))
    expect(sticky).toEqual(["key-b"])

    // A new request while the primary still cools goes straight to the overage account.
    time = 5_000
    const later = await authorization(transport, "ses_2")
    expect(later.request.headers.get("authorization")).toBe("Bearer key-b")
    expect(lookups).toEqual(["Bearer key-a"])

    // Once the cooldown ends the primary is an ordinary candidate again, and a later cooldown earns a new advisory attempt.
    time = 31_000
    const recovered = await authorization(transport)
    expect(recovered.request.headers.get("authorization")).toBe("Bearer key-a")
    await respond(transport, recovered, quota())
    transport.endSession(scope.sessionID)
    const second = await authorization(transport)
    expect(second.request.headers.get("authorization")).toBe("Bearer key-a")
    expect(lookups).toEqual(["Bearer key-a", "Bearer key-a"])
  })

  it("chooses another fallback when the chosen one was blocked while the lookup waited", async () => {
    let started = false
    let answer!: (response: Response) => void
    const { pool, transport } = setup(
      [account("key-a"), account("key-b", "overage_fallback"), account("key-c", "overage_fallback")],
      {
        fetch: () => new Promise((resolve) => {
          started = true
          answer = resolve
        }),
      },
    )
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    const olderLease = pool.lease({ account: pool.accounts[1], index: 1 })

    const event = httpRequest()
    const pending = transport["http.request"](event)
    while (!started) await settled()
    pool.settlePenalty(olderLease, { class: "auth", reason: "http_401" })
    answer(new Response("", { status: 500 }))
    await pending
    expect(pool.state.blocked).toEqual(new Set([1]))
    expect(event.request.headers.get("authorization")).toBe("Bearer key-c")
  })

  it("rejects an advisory primary penalized again while the lookup waited", async () => {
    let started = false
    let answer!: (response: Response) => void
    const { pool, transport } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      now: () => 0,
      fetch: () => new Promise((resolve) => {
        started = true
        answer = resolve
      }),
    })
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    const olderLease = pool.lease({ account: pool.accounts[0], index: 0 })

    const event = httpRequest()
    const pending = transport["http.request"](event)
    while (!started) await settled()
    pool.settlePenalty(olderLease, { class: "quota", reason: "body_rate_limit", cooldownSource: "default", cooldownMs: 60_000, cooldownUntil: 60_000 })
    answer(remaining())
    await pending
    expect(event.request.headers.get("authorization")).toBe("Bearer key-b")
  })

  it("ends an advisory wait when the session ends, injecting nothing and leaving the shared lookup running", async () => {
    let lookupSignal: AbortSignal | undefined
    const { pool, transport } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      fetch: (input) => new Promise((_, reject) => {
        const signal = (input as Request).signal
        lookupSignal = signal
        signal.addEventListener("abort", () => reject(signal.reason))
      }),
    })
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    const event = httpRequest()
    const pending = transport["http.request"](event)
    while (!lookupSignal) await settled()
    transport.endSession(scope.sessionID)
    await pending
    // The stopped attempt leaves the host's request alone and registers no lease.
    expect(bearer(event)).toBe("Bearer host-key")
    await respond(transport, event, invalidKey())
    expect(pool.state.blocked.size).toBe(0)
    expect(pool.advisoryAttempts().size).toBe(0)
    expect(lookupSignal.aborted).toBe(false)
    pool.dispose()
  })

  it("offers one cooling primary to a single attempt when two share the lookup", async () => {
    let answer!: (response: Response) => void
    let lookups = 0
    const { transport } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      fetch: () => new Promise((resolve) => {
        lookups++
        answer = resolve
      }),
    })
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    const first = httpRequest(undefined, "primary", "ses_1")
    const second = httpRequest(undefined, "primary", "ses_2")
    const pending = [transport["http.request"](first), transport["http.request"](second)]
    while (lookups === 0) await settled()
    answer(remaining())
    await Promise.all(pending)
    expect(lookups).toBe(1)
    expect([bearer(first), bearer(second)].sort()).toEqual(["Bearer key-a", "Bearer key-b"])
  })

  it("falls back when the chosen primary is penalized after the lookup returned but before the attempt took its lease", async () => {
    let checks = 0
    let olderLease!: ReturnType<ReturnType<typeof createAccountPool>["lease"]>
    const { pool, transport } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      now: () => 0,
      fetch: async () => remaining(),
      // The second check runs after the lookup returned, the last wait before the lease.
      authorize: async () => {
        if (++checks === 2) {
          pool.settlePenalty(olderLease, { class: "quota", reason: "body_rate_limit", cooldownSource: "default", cooldownMs: 60_000, cooldownUntil: 60_000 })
        }
        return true
      },
    })
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    olderLease = pool.lease({ account: pool.accounts[0], index: 0 })
    checks = 0
    const event = await begin(transport)
    expect(checks).toBe(2)
    expect(bearer(event)).toBe("Bearer key-b")
  })

  it("does not take an advisory primary or ordinary recovery for an account the chain failed with", async () => {
    const { transport } = setup([account("key-a"), account("key-b", "overage_fallback")])
    const failed = await begin(transport)
    await respond(transport, failed, invalidKey())
    // key-a is blocked; the chain's next attempt cannot return to it and uses key-b.
    expect(bearer(await begin(transport))).toBe("Bearer key-b")
  })
})

describe("V2 provider ownership", () => {
  it("leaves requests, outcomes and retries alone while the provider is not the pool's", async () => {
    let owned = false
    const { pool, transport } = setup([account("key-a"), account("key-b")], { authorize: async () => owned })

    const foreign = httpRequest()
    await transport["http.request"](foreign)
    expect(foreign.request.headers.get("authorization")).toBe("Bearer host-key")
    await respond(transport, foreign, invalidKey())
    expect(pool.state.blocked.size).toBe(0)

    const socket = { Authorization: "Bearer host-key" }
    await transport["experimental.ws.handshake"]({ ...scope, kind: "primary", url: "wss://gateway.example/v1", headers: socket } as SessionWebSocketHandshake)
    expect(socket).toEqual({ Authorization: "Bearer host-key" })

    const retry = retryEvent(401, undefined, scope.sessionID, { retry: false })
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: false })

    owned = true
    const own = httpRequest()
    await transport["http.request"](own)
    expect(own.request.headers.get("authorization")).toBe("Bearer key-a")
  })
})

describe("V2 session end", () => {
  const gate = () => {
    let release!: () => void
    const open = new Promise<void>((resolve) => { release = resolve })
    return { open, release }
  }

  it("neither injects a key nor registers a lease when the session ends while the attempt waits to be authorized", async () => {
    const { open, release } = gate()
    let waiting = false
    const { pool, transport } = setup([account("key-a"), account("key-b")], {
      authorize: async () => {
        if (waiting) await open
        return true
      },
    })
    waiting = true
    const event = httpRequest()
    const pending = transport["http.request"](event)
    transport.endSession(scope.sessionID)
    release()
    await pending
    expect(bearer(event)).toBe("Bearer host-key")
    await respond(transport, event, invalidKey())
    expect(pool.state.blocked.size).toBe(0)
  })

  it("settles the pool when a response is classified after its session ended but writes nothing to the ended chain", async () => {
    const { pool, transport } = setup([account("key-a"), account("key-b")])
    const event = await begin(transport)
    let push!: (chunk: string) => void
    let close!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
        close = () => controller.close()
      },
    })
    const pending = respond(transport, event, new Response(body, { status: 401, headers: { "content-type": "application/json" } }))
    await settled()
    transport.endSession(scope.sessionID)
    push(JSON.stringify({ error: { code: "invalid_api_key" } }))
    close()
    await pending
    // The account fact stands; the ended session's retry state does not.
    expect(pool.state.blocked).toEqual(new Set([0]))
    const retry = retryEvent(401)
    await transport.retry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
  })

  it("lets an auxiliary request without a session scope wait only as long as the pool lives", async () => {
    let lookupStarted = false
    const { pool, transport } = setup([account("key-a"), account("key-b", "overage_fallback")], {
      fetch: (input) => new Promise((_, reject) => {
        lookupStarted = true
        const signal = (input as Request).signal
        signal.addEventListener("abort", () => reject(signal.reason))
      }),
    })
    await send(transport, quota())
    transport.endSession(scope.sessionID)
    const pending = begin(transport, "title", "ses_unseen")
    while (!lookupStarted) await settled()
    pool.dispose()
    const event = await pending
    expect(bearer(event)).toBe("Bearer key-b")
  })
})
