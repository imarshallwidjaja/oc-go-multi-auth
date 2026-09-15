import { describe, it, expect } from "bun:test"
import { getEventListeners } from "node:events"
import { createRotatingFetch } from "../fetch"
import type { GoAccount } from "../types"

const mk = (
  apiKey: string,
  enabled = true,
  label?: string,
  role: GoAccount["role"] = "primary",
): GoAccount => ({
  apiKey,
  label,
  addedAt: Date.now(),
  enabled,
  role,
})

function mockRes(status: number, body = "ok", headers?: HeadersInit) {
  return new Response(body, { status, headers })
}

function spyReadableStreamCancel() {
  const original = ReadableStream.prototype.cancel
  let calls = 0
  ReadableStream.prototype.cancel = function (reason?: unknown) {
    calls++
    return original.call(this, reason)
  }
  return {
    get calls() { return calls },
    restore() { ReadableStream.prototype.cancel = original },
  }
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit) {
  return new Headers(input instanceof Request ? input.headers : init?.headers)
}

const quietLogger = () => {}

async function expectRotatableBody(body: string, contentType = "text/plain") {
  const accounts = [mk("key1"), mk("key2")]
  let callCount = 0
  const baseFetch = async () => {
    callCount++
    return callCount === 1
      ? mockRes(403, body, { "content-type": contentType })
      : mockRes(200)
  }

  const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
  const response = await fetch("https://api.example.com")

  expect(callCount).toBe(2)
  expect(response.status).toBe(200)
}

async function expectNonRotatableBody(body: string, contentType = "text/plain", status = 400) {
  const accounts = [mk("key1"), mk("key2")]
  const responses: Response[] = []
  let callCount = 0
  const baseFetch = async () => {
    callCount++
    const response = mockRes(status, body, { "content-type": contentType })
    responses.push(response)
    return response
  }

  const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
  const response = await fetch("https://api.example.com")

  expect(callCount).toBe(1)
  expect(response).toBe(responses[0])
  expect(response.bodyUsed).toBe(false)
  expect(await response.text()).toBe(body)
}

describe("createRotatingFetch", () => {
  it("replaces the authorization header and preserves other headers", async () => {
    const accounts = [mk("key1"), mk("key2")]
    let capturedHeaders: Headers | undefined
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = requestHeaders(input, init)
      return mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    await fetch("https://api.example.com", {
      headers: { Authorization: "Bearer old-key", "content-type": "application/json" },
    })

    expect(capturedHeaders!.get("Authorization")).toBe("Bearer key1")
    expect(capturedHeaders!.get("content-type")).toBe("application/json")
  })

  it("tries every account once, then keeps the successful replacement sticky", async () => {
    const accounts = [mk("key-a"), mk("key-b"), mk("key-c")]
    const authHeaders: string[] = []
    const persisted: number[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      return authorization === "Bearer key-c" ? mockRes(200) : mockRes(429, "quota exceeded")
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      onStickyChange: (account) => persisted.push(accounts.indexOf(account)),
    })

    expect((await fetch("https://api.example.com/first")).status).toBe(200)
    expect((await fetch("https://api.example.com/second")).status).toBe(200)
    expect(authHeaders).toEqual([
      "Bearer key-a",
      "Bearer key-b",
      "Bearer key-c",
      "Bearer key-c",
    ])
    expect(state.activeIndex).toBe(2)
    expect(state.cooldownUntil.has(0)).toBe(true)
    expect(state.cooldownUntil.has(1)).toBe(true)
    expect(persisted).toEqual([2])
  })

  it("waits for the earliest cooldown and retries all accounts in a new pass", async () => {
    const accounts = [mk("key-a"), mk("key-b"), mk("key-c"), mk("key-d")]
    const authHeaders: string[] = []
    const waits: number[] = []
    let now = 10_000
    let callCount = 0
    const retryAfter = ["4", "1", "3", "2"]
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(requestHeaders(input, init).get("Authorization")!)
      callCount++
      if (callCount <= accounts.length) {
        return mockRes(429, "quota exceeded", { "Retry-After": retryAfter[callCount - 1] })
      }
      return mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      wait: async (delayMs) => {
        waits.push(delayMs)
        now += delayMs
      },
    })

    expect((await fetch("https://api.example.com/retry-after-cooldown")).status).toBe(200)
    expect((await fetch("https://api.example.com/sticky")).status).toBe(200)
    expect(authHeaders).toEqual([
      "Bearer key-a",
      "Bearer key-b",
      "Bearer key-c",
      "Bearer key-d",
      "Bearer key-b",
      "Bearer key-b",
    ])
    expect(waits).toEqual([1_000])
  })

  it("does not probe the cooling sticky account before its cooldown expires", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const authHeaders: string[] = []
    const waits: number[] = []
    let now = 0
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input as Request
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      if (request.url.endsWith("/prime")) {
        return authorization === "Bearer key-a"
          ? mockRes(429, "quota exceeded")
          : mockRes(500, "terminal provider failure")
      }
      return authorization === "Bearer key-b"
        ? mockRes(429, "quota exceeded", { "Retry-After": "120" })
        : mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      wait: async (delayMs) => {
        waits.push(delayMs)
        now += delayMs
      },
    })

    expect((await fetch("https://api.example.com/prime")).status).toBe(500)
    expect((await fetch("https://api.example.com/retry")).status).toBe(200)
    expect(authHeaders).toEqual([
      "Bearer key-a",
      "Bearer key-b",
      "Bearer key-b",
      "Bearer key-a",
    ])
    expect(waits).toEqual([60_000])
  })

  it("stops waiting for a cooldown when the caller aborts", async () => {
    const controller = new AbortController()
    const abort = new Error("caller cancelled")
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return mockRes(429, "quota exceeded", { "Retry-After": "60" })
    }
    const { fetch } = createRotatingFetch([mk("key-a")], -1, baseFetch, {
      logger: quietLogger,
    })

    const pending = fetch("https://api.example.com/cancel", { signal: controller.signal })
    setTimeout(() => controller.abort(abort), 0)

    await expect(pending).rejects.toBe(abort)
    expect(callCount).toBe(1)
  })

  it("cancels ordinary stalled 429 inspection when the caller aborts", async () => {
    const controller = new AbortController()
    const abort = new DOMException("request aborted", "AbortError")
    const cancelled = Promise.withResolvers<void>()
    const responseReady = Promise.withResolvers<void>()
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.resolve()
      },
    })
    const { fetch } = createRotatingFetch([mk("key-a")], -1, async () => {
      responseReady.resolve()
      return new Response(stalled, {
        status: 429,
        headers: { "content-type": "text/plain" },
      })
    }, {
      logger: quietLogger,
      inspectionTimeoutMs: 5_000,
    })

    const pending = fetch("https://api.example.com/cancel-inspection", { signal: controller.signal })
    await responseReady.promise
    controller.abort(abort)

    await expect(Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort timed out")), 100)),
    ])).rejects.toBe(abort)
    await expect(Promise.race([
      cancelled.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream cancellation timed out")), 100)),
    ])).resolves.toBeUndefined()
  })

  it("returns an engine-overload 429 intact without rotating or penalizing the sticky account", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const authHeaders: string[] = []
    const overload = mockRes(429, "The engine is currently overloaded, please try again later")
    let callCount = 0
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(requestHeaders(input, init).get("Authorization")!)
      callCount++
      return callCount === 1 ? overload : mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const response = await fetch("https://api.example.com/overload")

    expect(response).toBe(overload)
    expect(response.bodyUsed).toBe(false)
    expect(await response.text()).toBe("The engine is currently overloaded, please try again later")
    expect((await fetch("https://api.example.com/next")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key-a", "Bearer key-a"])
    expect(state.activeIndex).toBe(0)
    expect(state.blocked.size).toBe(0)
    expect(state.cooldownUntil.size).toBe(0)
  })

  it("does not rotate or penalize an unknown bare 429", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const response = mockRes(429, "")
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return response
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const result = await fetch("https://api.example.com")

    expect(result).toBe(response)
    expect(callCount).toBe(1)
    expect(state.blocked.size).toBe(0)
    expect(state.cooldownUntil.size).toBe(0)
  })

  it("returns an unknown 429 with Retry-After intact without rotating or penalizing", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const responses: Response[] = []
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      const response = mockRes(429, "provider busy", { "Retry-After": "120" })
      responses.push(response)
      return response
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const result = await fetch("https://api.example.com")

    expect(result).toBe(responses[0])
    expect(callCount).toBe(1)
    expect(result.bodyUsed).toBe(false)
    expect(state.blocked.size).toBe(0)
    expect(state.cooldownUntil.size).toBe(0)
  })

  it("makes one upstream call per sustained overload request", async () => {
    const accounts = [mk("key-a"), mk("key-b"), mk("key-c"), mk("key-d")]
    const authHeaders: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(requestHeaders(input, init).get("Authorization")!)
      return mockRes(429, "engine overloaded")
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    for (let request = 0; request < 5; request++) {
      expect((await fetch(`https://api.example.com/${request}`)).status).toBe(429)
    }

    expect(authHeaders).toEqual(Array(5).fill("Bearer key-a"))
  })

  it("rotates on a pre-body 401 even when its content type is SSE", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const authHeaders: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(requestHeaders(input, init).get("Authorization")!)
      return authHeaders.length === 1
        ? mockRes(401, "data: unauthorized\n\n", { "content-type": "text/event-stream ; charset=utf-8" })
        : mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    expect((await fetch("https://api.example.com")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key1", "Bearer key2"])
  })

  it("rotates on 402", async () => {
    const accounts = [mk("key1"), mk("key2")]
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return callCount === 1 ? mockRes(402) : mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    expect((await fetch("https://api.example.com")).status).toBe(200)
    expect(callCount).toBe(2)
  })

  it("cools a clear quota failure for 60 seconds and keeps its successful replacement sticky", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const authHeaders: string[] = []
    const persisted: number[] = []
    const now = 1_800_000_000_000
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      return authorization === "Bearer key-a" ? mockRes(429, "quota exceeded") : mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      onStickyChange: (account) => persisted.push(accounts.indexOf(account)),
    })

    expect((await fetch("https://api.example.com/first")).status).toBe(200)
    expect((await fetch("https://api.example.com/second")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b"])
    expect(state.cooldownUntil.get(0)).toBe(now + 60_000)
    expect(state.activeIndex).toBe(1)
    expect(persisted).toEqual([1])
  })

  it("uses the default cooldown for clear quota with malformed, zero, or past Retry-After", async () => {
    const now = 1_800_000_000_000
    const retryAfterValues = ["invalid", "0", new Date(now - 1_000).toUTCString()]

    for (const retryAfter of retryAfterValues) {
      const stopped = new Error("stop after cooldown calculation")
      let waitMs: number | undefined
      const baseFetch = async () => mockRes(429, "quota exceeded", { "Retry-After": retryAfter })
      const { fetch, state } = createRotatingFetch([mk("key-a")], -1, baseFetch, {
        logger: quietLogger,
        now: () => now,
        wait: async (delayMs) => {
          waitMs = delayMs
          throw stopped
        },
      })

      await expect(fetch("https://api.example.com")).rejects.toBe(stopped)
      expect(waitMs).toBe(60_000)
      expect(state.cooldownUntil.get(0)).toBe(now + 60_000)
    }
  })

  it("preserves an absolute Retry-After date when response inspection advances the clock", async () => {
    const startedAt = 1_800_000_000_000
    let now = startedAt
    const response = mockRes(429, "quota exceeded", {
      "Retry-After": new Date(startedAt + 10_000).toUTCString(),
    })
    const originalClone = response.clone.bind(response)
    response.clone = () => {
      now += 5_000
      return originalClone()
    }
    const stopped = new Error("stop after cooldown calculation")
    let waitMs: number | undefined
    const baseFetch = async () => response
    const { fetch, state } = createRotatingFetch([mk("key-a")], -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      wait: async (delayMs) => {
        waitMs = delayMs
        throw stopped
      },
    })

    await expect(fetch("https://api.example.com")).rejects.toBe(stopped)
    expect(waitMs).toBe(5_000)
    expect(state.cooldownUntil.get(0)).toBe(startedAt + 10_000)
  })

  it("parses Retry-After seconds and dates for clear quota and caps cooldowns at ten minutes", async () => {
    const now = 1_800_000_000_000
    const cases = [
      { retryAfter: "120", expectedUntil: now + 120_000 },
      { retryAfter: new Date(now + 240_000).toUTCString(), expectedUntil: now + 240_000 },
      { retryAfter: new Date(now + 3_600_000).toUTCString(), expectedUntil: now + 600_000 },
      { retryAfter: "3600", expectedUntil: now + 600_000 },
      { retryAfter: "9".repeat(400), expectedUntil: now + 600_000 },
    ]

    for (const testCase of cases) {
      const stopped = new Error("stop after cooldown calculation")
      let waitMs: number | undefined
      const baseFetch = async () => mockRes(429, "quota exceeded", { "Retry-After": testCase.retryAfter })
      const { fetch, state } = createRotatingFetch([mk("key-a")], -1, baseFetch, {
        logger: quietLogger,
        now: () => now,
        wait: async (delayMs) => {
          waitMs = delayMs
          throw stopped
        },
      })

      await expect(fetch("https://api.example.com")).rejects.toBe(stopped)
      expect(waitMs).toBe(testCase.expectedUntil - now)
      expect(state.cooldownUntil.get(0)).toBe(testCase.expectedUntil)
    }
  })

  it("re-enables an account after its cooldown expires", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const authHeaders: string[] = []
    let now = 0
    let keyBCalls = 0
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      if (authorization === "Bearer key-a") {
        return authHeaders.length === 1 ? mockRes(429, "quota exceeded") : mockRes(200)
      }
      keyBCalls++
      return keyBCalls === 1 ? mockRes(200) : mockRes(401)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs
      },
    })

    expect((await fetch("https://api.example.com/first")).status).toBe(200)
    now = 30_000
    expect((await fetch("https://api.example.com/block-sticky")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b", "Bearer key-a"])
    expect(state.activeIndex).toBe(0)
    expect(state.cooldownUntil.has(0)).toBe(false)
  })

  it("blocks a 401 credential and skips it across later requests", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const authHeaders: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      return authorization === "Bearer key-a" ? mockRes(401) : mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })

    expect((await fetch("https://api.example.com/first")).status).toBe(200)
    expect((await fetch("https://api.example.com/second")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b"])
    expect(state.blocked).toEqual(new Set([0]))
  })

  it("keeps an auth block when its last-resort probe succeeds", async () => {
    const accounts = [mk("key-a")]
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return callCount === 1 ? mockRes(401) : mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })

    expect((await fetch("https://api.example.com/block")).status).toBe(401)
    expect((await fetch("https://api.example.com/probe")).status).toBe(200)
    expect(state.blocked).toEqual(new Set([0]))
  })

  it("probes the sticky credential once and returns its real response when all accounts are auth-blocked", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const authHeaders: string[] = []
    let keyACalls = 0
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      if (authorization === "Bearer key-a") {
        keyACalls++
        return keyACalls === 1 ? mockRes(401, "blocked-a") : mockRes(401, "real-probe-response")
      }
      return mockRes(401, "blocked-b")
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    expect((await fetch("https://api.example.com/exhaust-candidates")).status).toBe(401)
    const probe = await fetch("https://api.example.com/probe")

    expect(authHeaders).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-a"])
    expect(probe.status).toBe(401)
    expect(await probe.text()).toBe("real-probe-response")
  })

  it("preserves a terminal upstream response after rotating on a bounded usage body", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const responses: Response[] = []
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      const body = callCount === 1
        ? JSON.stringify({ error: "usage limit reached" })
        : JSON.stringify({ error: "provider failure", requestId: "provider-request-2" })
      const response = mockRes(403, body, { "content-type": "application/json" })
      responses.push(response)
      return response
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const res = await fetch("https://api.example.com")
    expect(callCount).toBe(2)
    expect(res).toBe(responses[1])
    expect(responses[0].bodyUsed).toBe(true)
    expect(responses[1].bodyUsed).toBe(false)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: "provider failure",
      requestId: "provider-request-2",
    })
  })

  for (const testCase of [
    { name: "rate limit exceeded", body: "rate limit exceeded" },
    { name: "rate limited", body: "request was rate limited" },
    { name: "too many requests", body: "too many requests" },
    { name: "usage limit reached", body: "usage limit reached" },
    { name: "usage limit exceeded", body: "usage limit exceeded" },
    { name: "usage limit exhausted", body: "usage limit exhausted" },
    { name: "quota exceeded", body: "monthly quota exceeded" },
    { name: "quota exhausted", body: "monthly quota exhausted" },
    { name: "insufficient quota", body: "insufficient quota" },
    { name: "invalid API key", body: "invalid API key" },
    { name: "API key is invalid", body: "API key is invalid" },
    { name: "API key is not valid", body: "This API key is not valid" },
    { name: "API key expired", body: "API key expired" },
    { name: "authentication failed", body: "authentication failed" },
    { name: "authentication required", body: "authentication required" },
    { name: "model entitlement", body: "not entitled to use this model" },
    { name: "model access", body: "You do not have access to this model" },
    { name: "entitlement required", body: "entitlement required" },
  ]) {
    it(`rotates on the terminal phrase: ${testCase.name}`, async () => {
      await expectRotatableBody(testCase.body)
    })
  }

  for (const testCase of [
    { name: "nested authentication_error code", body: { error: { code: "authentication_error" } } },
    { name: "nested invalid_api_key type", body: { error: { type: "invalid_api_key" } } },
    { name: "top-level incorrect_api_key code", body: { code: "incorrect_api_key" } },
    { name: "top-level rate_limit_error type", body: { type: "rate_limit_error" } },
    { name: "nested rate_limit_exceeded code", body: { error: { code: "rate_limit_exceeded" } } },
    { name: "nested insufficient_quota type", body: { error: { type: "insufficient_quota" } } },
    { name: "top-level quota_exceeded code", body: { code: "quota_exceeded" } },
    { name: "nested usage_limit_reached code", body: { error: { code: "usage_limit_reached" } } },
    { name: "top-level usage_limit_exceeded type", body: { type: "usage_limit_exceeded" } },
    { name: "nested entitlement_required type", body: { error: { type: "entitlement_required" } } },
    { name: "top-level model_access_denied code", body: { code: "model_access_denied" } },
    { name: "nested model_not_entitled code", body: { error: { code: "model_not_entitled" } } },
    { name: "string authentication_error discriminator", body: { error: "authentication_error" } },
    { name: "nested terminal message", body: { error: { message: "entitlement required" } } },
    {
      name: "terminal message without a blocking discriminator",
      body: { error: { type: "provider_error", message: "rate limit exceeded" } },
    },
    {
      name: "terminal description without a blocking discriminator",
      body: { error: { type: "provider_error", description: "authentication failed" } },
    },
  ]) {
    it(`rotates on the structured discriminator: ${testCase.name}`, async () => {
      await expectRotatableBody(JSON.stringify(testCase.body), "application/json")
    })
  }

  for (const testCase of [
    {
      name: "request validation requiring an authentication field",
      body: "request validation failed: authentication required field is missing",
      contentType: "text/plain",
      status: 403,
    },
    {
      name: "API key format validation",
      body: "invalid API key must match the expected format",
      contentType: "text/plain",
    },
    {
      name: "rate-limit enumeration validation",
      body: "rate limit exceeded must be one of the allowed enumeration values",
      contentType: "text/plain",
    },
    {
      name: "quota schema example",
      body: "schema example: quota exceeded",
      contentType: "text/plain",
    },
    {
      name: "missing usage-limit field",
      body: "usage limit exceeded because required field usage_window is missing",
      contentType: "text/plain",
    },
    {
      name: "model access expected type",
      body: "You do not have access to this model: expected type is string",
      contentType: "text/plain",
    },
    {
      name: "overload schema example",
      body: "schema example: engine overloaded",
      contentType: "text/plain",
    },
    { name: "rate-limit validation", body: "rate_limit must be a positive integer", contentType: "text/plain" },
    { name: "usage-limit validation", body: "usage limit must be between 1 and 100", contentType: "text/plain" },
    { name: "bare authentication token", body: "authentication_error", contentType: "text/plain" },
    {
      name: "invalid request enumerating authentication_error",
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "type must be one of: invalid_request_error, authentication_error",
        },
      }),
      contentType: "application/json",
    },
    {
      name: "allowlisted discriminator alongside a validation discriminator",
      body: JSON.stringify({
        error: { type: "validation_error", code: "insufficient_quota", message: "validation failed" },
      }),
      contentType: "application/json",
    },
    {
      name: "invalid request enumerating terminal reasons",
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "reason must be one of: validation failed, rate limit exceeded",
        },
      }),
      contentType: "application/json",
    },
    {
      name: "validation error containing a terminal description",
      body: JSON.stringify({
        error: { code: "validation_error", description: "authentication failed" },
      }),
      contentType: "application/json",
    },
    {
      name: "request validation error containing a terminal message",
      body: JSON.stringify({
        type: "request_validation_error",
        message: "quota exceeded",
      }),
      contentType: "application/json",
    },
    {
      name: "description containing a terminal phrase",
      body: JSON.stringify({ type: "invalid_request_error", description: "rate limit exceeded" }),
      contentType: "application/json",
    },
    {
      name: "validation error containing an overload signal",
      body: JSON.stringify({ type: "validation_error", message: "engine overloaded" }),
      contentType: "application/json",
    },
    {
      name: "schema containing an allowlisted code",
      body: JSON.stringify({ schema: { enum: ["authentication_error"] } }),
      contentType: "application/json",
    },
    {
      name: "example containing an allowlisted code",
      body: JSON.stringify({ example: { error: { code: "invalid_api_key" } } }),
      contentType: "application/json",
    },
  ]) {
    it(`does not rotate on ${testCase.name}`, async () => {
      await expectNonRotatableBody(testCase.body, testCase.contentType, testCase.status)
    })
  }

  it("rotates on decisive never-closing plaintext at the inspection deadline", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const inspectionTimeoutMs = 20
    let callCount = 0
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("quota exhausted"))
      },
    }), { status: 403, headers: { "content-type": "text/plain" } })
    const baseFetch = async () => {
      callCount++
      return callCount === 1 ? response : mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      inspectionTimeoutMs,
    })

    const startedAt = performance.now()
    expect((await fetch("https://api.example.com")).status).toBe(200)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(inspectionTimeoutMs - 2)
    expect(callCount).toBe(2)
  })

  it("keeps a plaintext terminal reason pending so a later validation chunk blocks rotation", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const chunks = ["authentication required", " field is missing: request validation failed"]
    const response = new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    }), { status: 403, headers: { "content-type": "text/plain" } })
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return callCount === 1 ? response : mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const result = await fetch("https://api.example.com")

    expect(callCount).toBe(1)
    expect(result).toBe(response)
    expect(result.bodyUsed).toBe(false)
    expect(await result.text()).toBe(chunks.join(""))
    expect(state.blocked.size).toBe(0)
    expect(state.cooldownUntil.size).toBe(0)
  })

  it("returns a never-closing non-decisive response intact at the inspection deadline", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const body = "request validation failed"
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
      },
    }), { status: 400, headers: { "content-type": "text/plain" } })
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return response
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      inspectionTimeoutMs: 0,
    })
    const result = await fetch("https://api.example.com")

    expect(callCount).toBe(1)
    expect(result).toBe(response)
    expect(result.bodyUsed).toBe(false)
    const reader = result.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(body)
    await reader.cancel()
  })

  it("preserves plaintext at the size cap instead of committing a pending terminal reason", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const terminalReason = "authentication required"
    const chunks = [terminalReason, "x".repeat((64 * 1024) - terminalReason.length)]
    const body = chunks.join("")
    const response = new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    }), { status: 403, headers: { "content-type": "text/plain" } })
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return response
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const result = await fetch("https://api.example.com")

    expect(callCount).toBe(1)
    expect(result).toBe(response)
    expect(await result.text()).toBe(body)
  })

  it("leaves a response readable when inspection cannot clone it", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const body = "authentication_error"
    const response = mockRes(403, body, { "content-type": "text/plain" })
    response.clone = () => {
      throw new TypeError("response cannot be cloned")
    }
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return response
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const result = await fetch("https://api.example.com")

    expect(callCount).toBe(1)
    expect(result).toBe(response)
    expect(await result.text()).toBe(body)
  })

  it("does not rotate on a bare 500", async () => {
    const accounts = [mk("key1"), mk("key2")]
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return mockRes(500, "internal server error", { "content-type": "text/plain" })
    }
    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const res = await fetch("https://api.example.com")
    expect(callCount).toBe(1)
    expect(res.status).toBe(500)
  })

  it("does not rotate non-success SSE responses", async () => {
    const accounts = [mk("key1"), mk("key2")]
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return mockRes(500, "data: quota exhausted\n\n", { "content-type": "text/event-stream" })
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const res = await fetch("https://api.example.com")
    expect(callCount).toBe(1)
    expect(await res.text()).toBe("data: quota exhausted\n\n")
  })

  it("does not inspect SSE when media type parameters have preceding whitespace", async () => {
    await expectNonRotatableBody("data: quota exhausted\n\n", "text/event-stream ; charset=utf-8")
  })

  it("parses JSON when media type parameters have preceding whitespace", async () => {
    await expectRotatableBody(
      JSON.stringify({ error: { code: "invalid_api_key" } }),
      "application/json ; charset=utf-8",
    )
  })

  it("returns a successful SSE response without inspecting its body", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const body = "data: authentication_error\n\n"
    const response = mockRes(200, body, { "content-type": "text/event-stream" })
    let cloneCount = 0
    response.clone = () => {
      cloneCount++
      throw new TypeError("successful SSE response must not be inspected")
    }
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return response
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const result = await fetch("https://api.example.com")

    expect(callCount).toBe(1)
    expect(cloneCount).toBe(0)
    expect(result).toBe(response)
    expect(await result.text()).toBe(body)
  })

  it("propagates network failures without rotating", async () => {
    const accounts = [mk("key1"), mk("key2")]
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      throw new TypeError("network unavailable")
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    await expect(fetch("https://api.example.com")).rejects.toThrow("network unavailable")
    expect(callCount).toBe(1)
    expect(state.blocked.size).toBe(0)
    expect(state.cooldownUntil.size).toBe(0)
  })

  it("propagates abort failures without rotating", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const abort = new DOMException("request aborted", "AbortError")
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      throw abort
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    await expect(fetch("https://api.example.com")).rejects.toBe(abort)
    expect(callCount).toBe(1)
    expect(state.blocked.size).toBe(0)
    expect(state.cooldownUntil.size).toBe(0)
  })

  it("fails closed without an upstream attempt for a consumed or locked Request", async () => {
    const accounts = [mk("key1"), mk("key2")]
    let callCount = 0
    const baseFetch = async () => {
      callCount++
      return mockRes(429)
    }
    const request = new Request("https://api.example.com", {
      method: "POST",
      body: "already consumed",
    })
    await request.text()
    const lockedRequest = new Request("https://api.example.com", {
      method: "POST",
      body: "currently locked",
    })
    const reader = lockedRequest.body!.getReader()

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })

    await expect(fetch(request)).rejects.toThrow()
    await expect(fetch(lockedRequest)).rejects.toThrow()
    expect(callCount).toBe(0)
    reader.releaseLock()
  })

  it("replays a Request JSON body with its method, signal, and headers", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const bodies: string[] = []
    const methods: string[] = []
    const signals: AbortSignal[] = []
    const contentTypes: string[] = []
    const controller = new AbortController()
    let callCount = 0
    const baseFetch = async (input: RequestInfo | URL) => {
      const request = input as Request
      callCount++
      methods.push(request.method)
      signals.push(request.signal)
      contentTypes.push(request.headers.get("content-type")!)
      bodies.push(await request.text())
      return callCount === 1 ? mockRes(429, "quota exceeded") : mockRes(200)
    }
    const request = new Request("https://api.example.com", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    })

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    expect((await fetch(request)).status).toBe(200)
    expect(methods).toEqual(["POST", "POST"])
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    controller.abort()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(contentTypes).toEqual(["application/json", "application/json"])
    expect(bodies).toEqual([
      JSON.stringify({ prompt: "hello" }),
      JSON.stringify({ prompt: "hello" }),
    ])
  })

  it("replays a RequestInit JSON body with its method and headers", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const bodies: string[] = []
    const methods: string[] = []
    const contentTypes: string[] = []
    let callCount = 0
    const baseFetch = async (input: RequestInfo | URL) => {
      const request = input as Request
      callCount++
      methods.push(request.method)
      contentTypes.push(request.headers.get("content-type")!)
      bodies.push(await request.text())
      return callCount === 1 ? mockRes(429, "quota exceeded") : mockRes(200)
    }
    const body = JSON.stringify({ prompt: "hello from init" })

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const response = await fetch("https://api.example.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    expect(response.status).toBe(200)
    expect(methods).toEqual(["POST", "POST"])
    expect(contentTypes).toEqual(["application/json", "application/json"])
    expect(bodies).toEqual([body, body])
  })

  it("skips disabled accounts", async () => {
    const accounts = [mk("disabled", false), mk("enabled", true)]
    const authHeaders: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(requestHeaders(input, init).get("Authorization")!)
      return mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    expect((await fetch("https://api.example.com")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer enabled"])
  })

  it("does not let a late success clear a newer penalty or steal stickiness", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const authHeaders: string[] = []
    const persisted: number[] = []
    let releaseLate!: () => void
    const lateResponse = new Promise<Response>((resolve) => {
      releaseLate = () => resolve(mockRes(200))
    })
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/late") && authorization === "Bearer key-a") return lateResponse
      if (authorization === "Bearer key-a") return mockRes(429, "quota exceeded")
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      onStickyChange: (account) => persisted.push(accounts.indexOf(account)),
    })
    const late = fetch("https://api.example.com/late")
    expect((await fetch("https://api.example.com/fast")).status).toBe(200)
    expect(state.activeIndex).toBe(1)

    releaseLate()
    expect((await late).status).toBe(200)
    expect(state.activeIndex).toBe(1)
    expect(state.cooldownUntil.has(0)).toBe(true)
    expect((await fetch("https://api.example.com/next")).status).toBe(200)
    expect(authHeaders).toEqual([
      "Bearer key-a",
      "Bearer key-a",
      "Bearer key-b",
      "Bearer key-b",
    ])
    expect(persisted).toEqual([1])
  })

  it("does not let a delayed B success steal stickiness after a newer A success", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const persisted: number[] = []
    let now = 0
    let releaseB!: () => void
    let markBStarted!: () => void
    const bStarted = new Promise<void>((resolve) => {
      markBStarted = resolve
    })
    const delayedB = new Promise<Response>((resolve) => {
      releaseB = () => resolve(mockRes(200))
    })
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/older") && authorization === "Bearer key-a") {
        return mockRes(429, "quota exceeded")
      }
      if (url.endsWith("/older") && authorization === "Bearer key-b") {
        markBStarted()
        return delayedB
      }
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      onStickyChange: (account) => persisted.push(accounts.indexOf(account)),
    })
    const older = fetch("https://api.example.com/older")
    await bStarted
    now = 60_000

    expect((await fetch("https://api.example.com/newer")).status).toBe(200)
    expect(state.activeIndex).toBe(0)
    releaseB()
    expect((await older).status).toBe(200)

    expect(state.activeIndex).toBe(0)
    expect(persisted).toEqual([])
  })

  it("keeps the newer logical success sticky when the older request completes first", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const persisted: number[] = []
    let now = 0
    let releaseOlderB!: () => void
    let markOlderBStarted!: () => void
    let releaseNewerA!: () => void
    let markNewerAStarted!: () => void
    const olderBStarted = new Promise<void>((resolve) => {
      markOlderBStarted = resolve
    })
    const delayedOlderB = new Promise<Response>((resolve) => {
      releaseOlderB = () => resolve(mockRes(200))
    })
    const newerAStarted = new Promise<void>((resolve) => {
      markNewerAStarted = resolve
    })
    const delayedNewerA = new Promise<Response>((resolve) => {
      releaseNewerA = () => resolve(mockRes(200))
    })
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/older") && authorization === "Bearer key-a") {
        return mockRes(429, "quota exceeded")
      }
      if (url.endsWith("/older") && authorization === "Bearer key-b") {
        markOlderBStarted()
        return delayedOlderB
      }
      if (url.endsWith("/newer") && authorization === "Bearer key-a") {
        markNewerAStarted()
        return delayedNewerA
      }
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      onStickyChange: (account) => persisted.push(accounts.indexOf(account)),
    })
    const older = fetch("https://api.example.com/older")
    await olderBStarted
    now = 60_000
    const newer = fetch("https://api.example.com/newer")
    await newerAStarted

    releaseOlderB()
    expect((await older).status).toBe(200)
    expect(state.activeIndex).toBe(1)
    expect(persisted).toEqual([1])

    releaseNewerA()
    expect((await newer).status).toBe(200)
    expect(state.activeIndex).toBe(0)
    expect(persisted).toEqual([1, 0])
  })

  it("does not let a stale auth response overwrite newer quota and success state", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    const persisted: number[] = []
    let releaseAuth!: () => void
    const delayedAuth = new Promise<Response>((resolve) => {
      releaseAuth = () => resolve(mockRes(401))
    })
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/stale-auth") && authorization === "Bearer key-a") return delayedAuth
      if (url.endsWith("/newer") && authorization === "Bearer key-a") return mockRes(429, "quota exceeded")
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => 0,
      onStickyChange: (account) => persisted.push(accounts.indexOf(account)),
    })
    const staleAuth = fetch("https://api.example.com/stale-auth")
    expect((await fetch("https://api.example.com/newer")).status).toBe(200)
    releaseAuth()
    expect((await staleAuth).status).toBe(200)

    expect(state.blocked.has(0)).toBe(false)
    expect(state.cooldownUntil.get(0)).toBe(60_000)
    expect(state.activeIndex).toBe(1)
    expect(persisted).toEqual([1])
  })

  it("does not let stale quota downgrade a newer auth block", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    let releaseQuota!: () => void
    const delayedQuota = new Promise<Response>((resolve) => {
      releaseQuota = () => resolve(mockRes(429, "quota exceeded"))
    })
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/stale-quota") && authorization === "Bearer key-a") return delayedQuota
      if (url.endsWith("/auth") && authorization === "Bearer key-a") return mockRes(401)
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const staleQuota = fetch("https://api.example.com/stale-quota")
    expect((await fetch("https://api.example.com/auth")).status).toBe(200)
    releaseQuota()
    expect((await staleQuota).status).toBe(200)

    expect(state.blocked.has(0)).toBe(true)
    expect(state.cooldownUntil.has(0)).toBe(false)
  })

  it("does not let a stale penalty overwrite a newer accepted success", async () => {
    const accounts = [mk("key-a"), mk("key-b")]
    let releaseQuota!: () => void
    const delayedQuota = new Promise<Response>((resolve) => {
      releaseQuota = () => resolve(mockRes(429, "quota exceeded"))
    })
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/stale-quota") && authorization === "Bearer key-a") return delayedQuota
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    const staleQuota = fetch("https://api.example.com/stale-quota")
    expect((await fetch("https://api.example.com/success")).status).toBe(200)
    releaseQuota()
    expect((await staleQuota).status).toBe(200)

    expect(state.blocked.has(0)).toBe(false)
    expect(state.cooldownUntil.has(0)).toBe(false)
  })

  it("does not resend the same overage credential after a delayed stale non-success", async () => {
    const accounts = [mk("key-overage", true, "overage", "overage_fallback")]
    const calls: string[] = []
    let releaseOlder!: () => void
    let markOlderStarted!: () => void
    const olderStarted = new Promise<void>((resolve) => {
      markOlderStarted = resolve
    })
    const delayedOlder = new Promise<Response>((resolve) => {
      releaseOlder = () => resolve(mockRes(429, "quota exceeded"))
    })
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      const url = input instanceof Request ? input.url : input.toString()
      calls.push(`${url} ${authorization}`)
      if (url.endsWith("/older") && calls.filter((call) => call.includes("/older")).length === 1) {
        markOlderStarted()
        return delayedOlder
      }
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => 1_000,
      wait: async () => {
        throw new Error("unexpected wait")
      },
    })
    state.activeIndex = 0

    const older = fetch("https://api.example.com/older")
    await olderStarted
    expect((await fetch("https://api.example.com/newer")).status).toBe(200)
    releaseOlder()
    const olderResponse = await older
    expect(olderResponse.status).toBe(429)
    expect(await olderResponse.text()).toBe("quota exceeded")
    expect(calls).toEqual([
      "https://api.example.com/older Bearer key-overage",
      "https://api.example.com/newer Bearer key-overage",
    ])
    expect(state.cooldownUntil.has(0)).toBe(false)
    expect(state.blocked.size).toBe(0)
    expect(state.activeIndex).toBe(0)
  })

  it("does not permanently poison accounts when a quota sequence ends in engine overload", async () => {
    const accounts = [mk("key-a"), mk("key-b"), mk("key-c"), mk("key-d")]
    const authHeaders: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      return authorization === "Bearer key-d"
        ? mockRes(429, "The engine is currently overloaded, please try again later")
        : mockRes(429, "quota exceeded")
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    expect((await fetch("https://api.example.com/incident")).status).toBe(429)
    expect((await fetch("https://api.example.com/retry-1")).status).toBe(429)
    expect((await fetch("https://api.example.com/retry-2")).status).toBe(429)

    expect(authHeaders).toEqual([
      "Bearer key-a",
      "Bearer key-b",
      "Bearer key-c",
      "Bearer key-d",
      "Bearer key-d",
      "Bearer key-d",
    ])
    expect(state.cooldownUntil.has(3)).toBe(false)
  })

  it("logs rotation, sticky replacement, and attempted candidates without sensitive values", async () => {
    const accounts = [mk("secret-key-a", true, "alpha"), mk("secret-key-b", true, "beta")]
    const entries: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    let now = 0
    let betaCalls = 0
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")
      if (authorization === "Bearer secret-key-a") return mockRes(429, "quota exceeded provider-secret-body")
      betaCalls++
      return betaCalls === 2 ? mockRes(429, "quota exceeded provider-secret-body") : mockRes(200)
    }
    const logger = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => {
      entries.push({ level, message, data })
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, {
      logger,
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs
      },
    })
    expect((await fetch("https://api.example.com", { method: "POST", body: "request-secret" })).status).toBe(200)
    expect((await fetch("https://api.example.com")).status).toBe(200)

    expect(entries.map((entry) => entry.message)).toEqual([
      "credential rotation",
      "sticky account replaced",
      "all candidates attempted",
      "credential rotation",
    ])
    expect(entries[0].data).toEqual({
      fromLabel: "alpha",
      fromIndex: 0,
      toLabel: "beta",
      toIndex: 1,
      status: 429,
      class: "quota",
      reason: "body_quota",
      cooldownSource: "default",
      cooldownMs: 60000,
    })
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain("secret-key-a")
    expect(serialized).not.toContain("secret-key-b")
    expect(serialized).not.toContain("provider-secret-body")
    expect(serialized).not.toContain("request-secret")
    expect(serialized.toLowerCase()).not.toContain("authorization")
  })

  it("logs overload rotation suppression without sensitive response data", async () => {
    const accounts = [mk("secret-key-a", true, "alpha"), mk("secret-key-b", true, "beta")]
    const entries: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const baseFetch = async () => mockRes(
      429,
      "The engine is currently overloaded with provider-secret-body",
      { "Retry-After": "120" },
    )
    const logger = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => {
      entries.push({ level, message, data })
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger })
    expect((await fetch("https://api.example.com")).status).toBe(429)

    expect(entries).toEqual([{
      level: "warn",
      message: "credential rotation suppressed",
      data: {
        label: "alpha",
        index: 0,
        status: 429,
        class: "overload",
        reason: "body_overload",
      },
    }])
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain("secret-key-a")
    expect(serialized).not.toContain("provider-secret-body")
    expect(serialized.toLowerCase()).not.toContain("retry-after")
  })

  it("uses the same account for consecutive calls", async () => {
    const accounts = [mk("key1"), mk("key2")]
    const authHeaders: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(requestHeaders(input, init).get("Authorization")!)
      return mockRes(200)
    }

    const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    await fetch("https://api.example.com")
    await fetch("https://api.example.com")
    await fetch("https://api.example.com")
    expect(authHeaders).toEqual(["Bearer key1", "Bearer key1", "Bearer key1"])
  })

  it("demotes sticky overage_fallback to an available primary without extra upstream attempts", async () => {
    const accounts = [
      mk("key-overage", true, "overage", "overage_fallback"),
      mk("key-primary", true, "primary", "primary"),
    ]
    const authHeaders: string[] = []
    const persisted: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(requestHeaders(input, init).get("Authorization")!)
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      onStickyChange: (account) => persisted.push(account.apiKey),
    })
    expect(state.activeIndex).toBe(0)

    expect((await fetch("https://api.example.com")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key-primary"])
    expect(state.activeIndex).toBe(1)
    expect(persisted).toEqual(["key-primary"])
  })

  it("stays on overage_fallback while primaries cool, then demotes after cooldown", async () => {
    const accounts = [
      mk("key-primary", true, "primary", "primary"),
      mk("key-overage", true, "overage", "overage_fallback"),
    ]
    const authHeaders: string[] = []
    let now = 1_000
    const waits: number[] = []
    let callCount = 0
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === "https://opencode.ai/zen/go/v1/usage") return mockRes(200, "not-json")
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      callCount++
      if (callCount === 1) return mockRes(429, "quota exceeded", { "Retry-After": "60" })
      return mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
      logger: quietLogger,
      now: () => now,
      wait: async (delayMs) => {
        waits.push(delayMs)
        now += delayMs
      },
    })

    expect((await fetch("https://api.example.com/failover")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key-primary", "Bearer key-overage"])
    expect(state.activeIndex).toBe(1)

    expect((await fetch("https://api.example.com/still-overage")).status).toBe(200)
    expect(authHeaders).toEqual([
      "Bearer key-primary",
      "Bearer key-overage",
      "Bearer key-overage",
    ])

    now = 1_000 + 60_000
    expect((await fetch("https://api.example.com/after-cooldown")).status).toBe(200)
    expect(authHeaders).toEqual([
      "Bearer key-primary",
      "Bearer key-overage",
      "Bearer key-overage",
      "Bearer key-primary",
    ])
    expect(state.activeIndex).toBe(0)
    expect(waits).toEqual([])
  })

  it("prefers any available primary over available overage_fallback during failover traversal", async () => {
    const accounts = [
      mk("key-a", true, "a", "primary"),
      mk("key-overage", true, "overage", "overage_fallback"),
      mk("key-b", true, "b", "primary"),
    ]
    const authHeaders: string[] = []
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = requestHeaders(input, init).get("Authorization")!
      authHeaders.push(authorization)
      return authorization === "Bearer key-a"
        ? mockRes(429, "quota exceeded")
        : mockRes(200)
    }

    const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
    expect((await fetch("https://api.example.com")).status).toBe(200)
    expect(authHeaders).toEqual(["Bearer key-a", "Bearer key-b"])
    expect(state.activeIndex).toBe(2)
  })

  const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

  function requestUrl(input: RequestInfo | URL) {
    return input instanceof Request ? input.url : String(input)
  }

  function isUsageRequest(input: RequestInfo | URL) {
    return requestUrl(input) === USAGE_URL
  }

  function usageWindow(status: "ok" | "rate-limited", percent = 12, resetsAt = "2026-08-13T16:27:38.287Z") {
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
        weekly: usageWindow("ok"),
        monthly: usageWindow("ok"),
        ...usageOverride,
      },
      ...rest,
    }
  }

  function usageResponse(body: unknown = usageBody(), status = 200, headers?: HeadersInit) {
    return mockRes(status, typeof body === "string" ? body : JSON.stringify(body), {
      "content-type": "application/json",
      ...headers,
    })
  }

  describe("advisory usage at overage crossing", () => {
    it("does not look up usage while a normal primary is available", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const urls: string[] = []
      const baseFetch = async (input: RequestInfo | URL) => {
        urls.push(requestUrl(input))
        return mockRes(200)
      }

      const { fetch } = createRotatingFetch(accounts, -1, baseFetch, { logger: quietLogger })
      expect((await fetch("https://api.example.com/available")).status).toBe(200)
      expect(urls).toEqual(["https://api.example.com/available"])
    })

    it("recovers one cooling primary when all usage windows are ok", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const usageAuth: string[] = []
      const usageMethods: string[] = []
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageAuth.push(requestHeaders(input, init).get("Authorization")!)
          usageMethods.push(input instanceof Request ? input.method : init?.method ?? "GET")
          return usageResponse(usageBody({ extra: "tolerated", usage: { rolling: { ...usageWindow("ok"), extra: 1 } } }))
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      expect((await fetch("https://api.example.com/recover")).status).toBe(200)
      expect(usageAuth).toEqual(["Bearer key-primary"])
      expect(usageMethods).toEqual(["GET"])
      expect(upstreamAuth).toEqual(["Bearer key-primary"])
      expect(state.activeIndex).toBe(0)
      expect(state.cooldownUntil.has(0)).toBe(false)
    })

    it("recovers when useBalance is non-boolean and all usage windows are ok", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) return usageResponse(usageBody({ useBalance: "yes" }))
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      expect((await fetch("https://api.example.com/recover-use-balance")).status).toBe(200)
      expect(upstreamAuth).toEqual(["Bearer key-primary"])
      expect(state.activeIndex).toBe(0)
    })

    for (const window of ["rolling", "weekly", "monthly"] as const) {
      it(`keeps overage when ${window} is rate-limited`, async () => {
        const accounts = [
          mk("key-primary", true, "primary", "primary"),
          mk("key-overage", true, "overage", "overage_fallback"),
        ]
        const upstreamAuth: string[] = []
        const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          if (isUsageRequest(input)) return usageResponse(usageBody({ usage: { [window]: usageWindow("rate-limited") } }))
          upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
          return mockRes(200)
        }

        const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
          logger: quietLogger,
          now: () => 1_000,
        })
        state.activeIndex = 1
        state.cooldownUntil.set(0, 61_000)

        expect((await fetch("https://api.example.com/limited")).status).toBe(200)
        expect(upstreamAuth).toEqual(["Bearer key-overage"])
        expect(state.activeIndex).toBe(1)
        expect(state.cooldownUntil.get(0)).toBe(61_000)
        expect(state.blocked.size).toBe(0)
      })
    }

    it("fails open to overage when usage lookup exceeds 750ms", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) return new Promise<Response>(() => {})
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      const started = Date.now()
      expect((await fetch("https://api.example.com/fail-open-timeout")).status).toBe(200)
      expect(Date.now() - started).toBeGreaterThanOrEqual(750)
      expect(upstreamAuth).toEqual(["Bearer key-overage"])
      expect(state.activeIndex).toBe(1)
      expect(state.cooldownUntil.get(0)).toBe(61_000)
      expect(state.blocked.size).toBe(0)
    })

    it("does not surface an unhandled rejection when usage lookup rejects after the 750ms timeout", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      let rejectUsage!: (error: Error) => void
      const usageGate = new Promise<Response>((_resolve, reject) => {
        rejectUsage = reject
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) return usageGate
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      try {
        expect((await fetch("https://api.example.com/late-reject")).status).toBe(200)
        expect(upstreamAuth).toEqual(["Bearer key-overage"])
        rejectUsage(new Error("late usage rejection"))
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })

    for (const testCase of [
      {
        name: "network failure",
        usage: async () => {
          throw new TypeError("usage network down")
        },
      },
      { name: "401", usage: async () => usageResponse("unauthorized", 401) },
      { name: "malformed JSON", usage: async () => usageResponse("not-json") },
      { name: "oversized content-length", usage: async () => usageResponse(usageBody(), 200, { "content-length": "999999" }) },
      { name: "missing windows", usage: async () => usageResponse({ usage: {} }) },
      { name: "invalid status", usage: async () => usageResponse(usageBody({ usage: { rolling: usageWindow("OK" as "ok") } })) },
      { name: "percent over 100", usage: async () => usageResponse(usageBody({ usage: { weekly: usageWindow("ok", 101) } })) },
      { name: "invalid resetsAt", usage: async () => usageResponse(usageBody({ usage: { monthly: usageWindow("ok", 10, "not-a-date") } })) },
    ]) {
      it(`fails open to overage on ${testCase.name}`, async () => {
        const accounts = [
          mk("key-primary", true, "primary", "primary"),
          mk("key-overage", true, "overage", "overage_fallback"),
        ]
        const upstreamAuth: string[] = []
        const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          if (isUsageRequest(input)) return testCase.usage()
          upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
          return mockRes(200)
        }

        const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
          logger: quietLogger,
          now: () => 1_000,
        })
        state.activeIndex = 1
        state.cooldownUntil.set(0, 61_000)

        expect((await fetch("https://api.example.com/fail-open")).status).toBe(200)
        expect(upstreamAuth).toEqual(["Bearer key-overage"])
        expect(state.activeIndex).toBe(1)
        expect(state.cooldownUntil.get(0)).toBe(61_000)
        expect(state.blocked.size).toBe(0)
      })
    }

    it("resumes the original overage after advisory quota failure when another overage exists", async () => {
      const accounts = [
        mk("key-overage-a", true, "overage-a", "overage_fallback"),
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage-b", true, "overage-b", "overage_fallback"),
      ]
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) return usageResponse()
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        return authorization === "Bearer key-primary"
          ? mockRes(429, "quota exceeded")
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 0
      state.cooldownUntil.set(1, 61_000)

      expect((await fetch("https://api.example.com/resume-overage-quota")).status).toBe(200)
      expect(upstreamAuth).toEqual(["Bearer key-primary", "Bearer key-overage-a"])
      expect(state.activeIndex).toBe(0)
    })

    it("resumes the original overage after advisory transport failure when another overage exists", async () => {
      const accounts = [
        mk("key-overage-a", true, "overage-a", "overage_fallback"),
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage-b", true, "overage-b", "overage_fallback"),
      ]
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) return usageResponse()
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        if (authorization === "Bearer key-primary") throw new TypeError("advisory network")
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 0
      state.cooldownUntil.set(1, 61_000)

      expect((await fetch("https://api.example.com/resume-overage-transport")).status).toBe(200)
      expect(upstreamAuth).toEqual(["Bearer key-primary", "Bearer key-overage-a"])
      expect(state.activeIndex).toBe(0)
      expect(state.blocked.size).toBe(0)
    })

    it("uses ordinary traversal when the original overage is unavailable after advisory failure", async () => {
      const accounts = [
        mk("key-overage-a", true, "overage-a", "overage_fallback"),
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage-b", true, "overage-b", "overage_fallback"),
      ]
      const upstreamAuth: string[] = []
      const { fetch, state } = createRotatingFetch(accounts, -1, async (input, init) => {
        if (isUsageRequest(input)) return usageResponse()
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        if (authorization === "Bearer key-primary") {
          state.blocked.add(0)
          return mockRes(429, "quota exceeded")
        }
        return mockRes(200)
      }, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 0
      state.cooldownUntil.set(1, 61_000)

      expect((await fetch("https://api.example.com/resume-overage-unavailable")).status).toBe(200)
      expect(upstreamAuth).toEqual(["Bearer key-primary", "Bearer key-overage-b"])
      expect(state.activeIndex).toBe(2)
    })

    it("queries cooling primaries concurrently and makes only one advisory attempt", async () => {
      const accounts = [
        mk("key-a", true, "a", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
        mk("key-b", true, "b", "primary"),
      ]
      let usageInFlight = 0
      let usagePeak = 0
      const usageAuth: string[] = []
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageAuth.push(requestHeaders(input, init).get("Authorization")!)
          usageInFlight++
          usagePeak = Math.max(usagePeak, usageInFlight)
          await Promise.resolve()
          usageInFlight--
          return usageResponse()
        }
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        return authorization === "Bearer key-b"
          ? mockRes(429, "quota exceeded")
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)
      state.cooldownUntil.set(2, 61_000)

      expect((await fetch("https://api.example.com/one-attempt")).status).toBe(200)
      expect(new Set(usageAuth)).toEqual(new Set(["Bearer key-a", "Bearer key-b"]))
      expect(usagePeak).toBe(2)
      expect(upstreamAuth).toEqual(["Bearer key-b", "Bearer key-overage"])
    })

    it("does not query disabled, blocked, available, or already-attempted primaries", async () => {
      const accounts = [
        mk("key-disabled", true, "disabled", "primary"),
        mk("key-blocked", true, "blocked", "primary"),
        mk("key-attempted", true, "attempted", "primary"),
        mk("key-cool", true, "cool", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      accounts[0].enabled = false
      const usageAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageAuth.push(requestHeaders(input, init).get("Authorization")!)
          return usageResponse()
        }
        const authorization = requestHeaders(input, init).get("Authorization")!
        return authorization === "Bearer key-attempted"
          ? mockRes(429, "quota exceeded")
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.blocked.add(1)
      state.cooldownUntil.set(3, 61_000)

      expect((await fetch("https://api.example.com/filter")).status).toBe(200)
      expect(usageAuth).toEqual(["Bearer key-cool"])
    })

    it("reuses a process-local usage cache within the TTL", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      let usageCalls = 0
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageCalls++
          return usageResponse(usageBody({ usage: { rolling: usageWindow("rate-limited") } }))
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      let now = 1_000
      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => now,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      expect((await fetch("https://api.example.com/cache-1")).status).toBe(200)
      now = 5_999
      expect((await fetch("https://api.example.com/cache-2")).status).toBe(200)
      expect(usageCalls).toBe(1)
      now = 6_001
      expect((await fetch("https://api.example.com/cache-3")).status).toBe(200)
      expect(usageCalls).toBe(2)
      expect(upstreamAuth).toEqual(["Bearer key-overage", "Bearer key-overage", "Bearer key-overage"])
    })

    it("deduplicates in-flight usage lookups across concurrent requests", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      let usageCalls = 0
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageCalls++
          return usageGate
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      const first = fetch("https://api.example.com/inflight-1")
      const second = fetch("https://api.example.com/inflight-2")
      await Promise.resolve()
      expect(usageCalls).toBe(1)
      releaseUsage(usageResponse())
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
      expect(usageCalls).toBe(1)
      expect(upstreamAuth).toEqual(["Bearer key-primary", "Bearer key-primary"])
    })

    it("rejects a stale usage result after availability generation changes", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      let now = 1_000
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageStarted()
          return usageGate
        }
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        return authorization === "Bearer key-primary"
          ? mockRes(429, "quota exceeded")
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => now,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 2_000)

      const waiting = fetch("https://api.example.com/stale-gen")
      await usageReady
      now = 2_000
      expect((await fetch("https://api.example.com/bump-gen")).status).toBe(200)
      releaseUsage(usageResponse())
      expect((await waiting).status).toBe(200)
      expect(upstreamAuth.filter((header) => header === "Bearer key-primary")).toEqual(["Bearer key-primary"])
      expect(upstreamAuth.filter((header) => header === "Bearer key-overage").length).toBeGreaterThanOrEqual(1)
      expect(state.activeIndex).toBe(1)
    })

    it("rejects a stale usage result when the candidate is no longer eligible", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageStarted()
          return usageGate
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      const waiting = fetch("https://api.example.com/stale-state")
      await usageReady
      state.blocked.add(0)
      releaseUsage(usageResponse())
      expect((await waiting).status).toBe(200)
      expect(upstreamAuth).toEqual(["Bearer key-overage"])
    })

    it("does not send a model request after a selected advisory primary becomes unavailable", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      let usageCalls = 0
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageCalls++
          usageStarted()
          return usageGate
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)
      const rawGet = state.cooldownUntil.get.bind(state.cooldownUntil)
      let armMutation = false
      state.cooldownUntil.get = (index: number) => {
        const value = rawGet(index)
        if (armMutation && index === 0) {
          armMutation = false
          queueMicrotask(() => {
            state.blocked.add(0)
          })
        }
        return value
      }

      const waiting = fetch("https://api.example.com/advisory-after-select")
      await usageReady
      armMutation = true
      releaseUsage(usageResponse())
      expect((await waiting).status).toBe(200)
      expect(upstreamAuth).toEqual(["Bearer key-overage"])
      expect(usageCalls).toBe(1)
      expect(state.blocked.has(0)).toBe(true)
      expect(state.cooldownUntil.get(0)).toBe(61_000)
    })

    for (const testCase of [
      {
        name: "blocked",
        mutate: (state: { blocked: Set<number>; cooldownUntil: Map<number, number> }, accounts: GoAccount[]) => {
          state.blocked.add(0)
        },
      },
      {
        name: "disabled",
        mutate: (state: { blocked: Set<number>; cooldownUntil: Map<number, number> }, accounts: GoAccount[]) => {
          accounts[0].enabled = false
        },
      },
      {
        name: "cooling",
        mutate: (state: { blocked: Set<number>; cooldownUntil: Map<number, number> }, accounts: GoAccount[]) => {
          state.cooldownUntil.set(0, 61_000)
        },
      },
    ]) {
      it(`does not send the original overage after it becomes ${testCase.name} during usage lookup`, async () => {
        const accounts = [
          mk("key-overage-a", true, "overage-a", "overage_fallback"),
          mk("key-primary", true, "primary", "primary"),
          mk("key-overage-b", true, "overage-b", "overage_fallback"),
        ]
        let releaseUsage!: (response: Response) => void
        const usageGate = new Promise<Response>((resolve) => {
          releaseUsage = resolve
        })
        let usageStarted!: () => void
        const usageReady = new Promise<void>((resolve) => {
          usageStarted = resolve
        })
        const upstreamAuth: string[] = []
        let usageCalls = 0
        const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          if (isUsageRequest(input)) {
            usageCalls++
            usageStarted()
            return usageGate
          }
          upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
          return mockRes(200)
        }

        const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
          logger: quietLogger,
          now: () => 1_000,
        })
        state.activeIndex = 0
        state.cooldownUntil.set(1, 61_000)

        const waiting = fetch("https://api.example.com/overage-stale")
        await usageReady
        testCase.mutate(state, accounts)
        releaseUsage(usageResponse(usageBody({ usage: { rolling: usageWindow("rate-limited") } })))
        expect((await waiting).status).toBe(200)
        expect(upstreamAuth).toEqual(["Bearer key-overage-b"])
        expect(usageCalls).toBe(1)
      })
    }

    it("does not send a selected overage that becomes blocked before the model attempt", async () => {
      const accounts = [
        mk("key-overage", true, "overage", "overage_fallback"),
        mk("key-primary", true, "primary", "primary"),
      ]
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageStarted()
          return usageGate
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
        wait: async () => {
          throw new Error("unexpected wait")
        },
      })
      state.activeIndex = 0
      state.cooldownUntil.set(1, 61_000)

      const waiting = fetch("https://api.example.com/blocked-overage-before-send")
      await usageReady
      state.blocked.add(0)
      state.blocked.add(1)
      releaseUsage(usageResponse(usageBody({ usage: { rolling: usageWindow("rate-limited") } })))

      await expect(waiting).rejects.toThrow("No enabled Go accounts")
      expect(upstreamAuth).toEqual([])
    })

    it("does not retry an already-attempted primary after stale reselection exhaustion", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
        mk("key-cooling", true, "cooling", "primary"),
      ]
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageStarted()
          return usageGate
        }
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        return authorization === "Bearer key-primary"
          ? mockRes(401, "primary-auth-failure")
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
        wait: async () => {
          throw new Error("unexpected wait")
        },
      })
      state.activeIndex = 0
      state.cooldownUntil.set(2, 61_000)

      const waiting = fetch("https://api.example.com/primary-twice")
      await usageReady
      state.blocked.add(1)
      state.blocked.add(2)
      releaseUsage(usageResponse(usageBody({ usage: { rolling: usageWindow("rate-limited") } })))

      const response = await waiting
      expect(upstreamAuth).toEqual(["Bearer key-primary"])
      expect(response.status).toBe(401)
      expect(await response.text()).toBe("primary-auth-failure")
    })

    it("clears the attempted pass after a real recovery wait and retries the recovered primary", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
        mk("key-cooling", true, "cooling", "primary"),
      ]
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      let now = 1_000
      const waits: number[] = []
      const cancelSpy = spyReadableStreamCancel()
      const upstreamAuth: string[] = []
      const retained = mockRes(429, "quota exceeded")
      let primaryCalls = 0
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageStarted()
          return usageGate
        }
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        if (authorization === "Bearer key-primary") {
          primaryCalls++
          return primaryCalls === 1 ? retained : mockRes(200)
        }
        return mockRes(200)
      }

      try {
        const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
          logger: quietLogger,
          now: () => now,
          wait: async (delayMs) => {
            waits.push(delayMs)
            now += delayMs
          },
        })
        state.cooldownUntil.set(2, 61_000)

        const pending = fetch("https://api.example.com/recover-after-wait")
        await usageReady
        state.blocked.add(1)
        state.blocked.add(2)
        releaseUsage(usageResponse(usageBody({ usage: { rolling: usageWindow("rate-limited") } })))

        const response = await pending
        expect(response.status).toBe(200)
        expect(upstreamAuth).toEqual(["Bearer key-primary", "Bearer key-primary"])
        expect(waits).toEqual([60_000])
        expect(cancelSpy.calls).toBe(1)
        expect(retained.body?.locked).toBe(false)
        expect(state.blocked.has(1)).toBe(true)
        expect(state.blocked.has(2)).toBe(true)
      } finally {
        cancelSpy.restore()
      }
    })

    it("fails open and releases a stalled usage body reader at the 750ms bound", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      let cancelCalled = false
      let usageSignal: AbortSignal | undefined
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      const stream = new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          cancelCalled = true
          return new Promise(() => {})
        },
      })
      const stalled = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageSignal = input instanceof Request ? input.signal : init?.signal
          return stalled
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      const started = Date.now()
      try {
        expect((await fetch("https://api.example.com/stalled-body")).status).toBe(200)
        expect(Date.now() - started).toBeGreaterThanOrEqual(750)
        expect(upstreamAuth).toEqual(["Bearer key-overage"])
        expect(cancelCalled).toBe(true)
        expect(stalled.body?.locked).toBe(false)
        expect(usageSignal ? getEventListeners(usageSignal, "abort") : ["missing"]).toHaveLength(0)
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
        expect(state.activeIndex).toBe(1)
        expect(state.cooldownUntil.get(0)).toBe(61_000)
        expect(state.blocked.size).toBe(0)
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })

    it("re-runs ordinary selection when usage returns after cooldown expires", async () => {
      const accounts = [
        mk("key-a", true, "a", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
        mk("key-b", true, "b", "primary"),
      ]
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      let usageCalls = 0
      let now = 1_000
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageCalls++
          usageStarted()
          return usageGate
        }
        const authorization = requestHeaders(input, init).get("Authorization")!
        upstreamAuth.push(authorization)
        return authorization === "Bearer key-b"
          ? mockRes(429, "quota exceeded")
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => now,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 2_000)
      state.cooldownUntil.set(2, 2_000)

      const pending = fetch("https://api.example.com/expired-cooldown")
      await usageReady
      now = 2_000
      releaseUsage(usageResponse())
      expect((await pending).status).toBe(200)
      expect(usageCalls).toBe(2)
      expect(upstreamAuth).toEqual(["Bearer key-b", "Bearer key-a"])
      expect(state.activeIndex).toBe(0)
    })

    it("does not route the usage lookup through rotating fetch", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      let usageCalls = 0
      const urls: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(requestUrl(input))
        if (isUsageRequest(input)) {
          usageCalls++
          expect(input instanceof Request ? input.method : init?.method ?? "GET").toBe("GET")
          return usageResponse("unauthorized", 401)
        }
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      expect((await fetch("https://api.example.com/no-recurse")).status).toBe(200)
      expect(usageCalls).toBe(1)
      expect(urls.filter((url) => url === USAGE_URL)).toHaveLength(1)
      expect(state.blocked.size).toBe(0)
      expect(state.cooldownUntil.get(0)).toBe(61_000)
    })

    it("does not start usage lookup when the caller is already aborted at an overage crossing", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const abort = new Error("already aborted")
      const controller = new AbortController()
      controller.abort(abort)
      let calls = 0
      const baseFetch = async () => {
        calls++
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      await expect(fetch("https://api.example.com/pre-aborted", { signal: controller.signal })).rejects.toBe(abort)
      expect(calls).toBe(0)
    })

    it("propagates caller abort while waiting for usage and keeps the shared lookup", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const abort = new Error("caller cancelled")
      let usageCalls = 0
      let usageSignal: AbortSignal | undefined
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageCalls++
          usageSignal = input instanceof Request ? input.signal : init?.signal
          usageStarted()
          return usageGate
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      const controller = new AbortController()
      const pending = fetch("https://api.example.com/abort-wait", { signal: controller.signal })
      await usageReady
      controller.abort(abort)
      await expect(pending).rejects.toBe(abort)
      expect(usageSignal?.aborted).toBe(false)

      releaseUsage(usageResponse())
      expect((await fetch("https://api.example.com/after-abort")).status).toBe(200)
      expect(usageCalls).toBe(1)
      expect(upstreamAuth).toEqual(["Bearer key-primary"])
    })

    it("does not send the fail-open overage model request when the caller aborts after usage settles", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const abort = new Error("caller cancelled after usage settled")
      const controller = new AbortController()
      let usageCalls = 0
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageCalls++
          return usageResponse(usageBody({ usage: { rolling: usageWindow("rate-limited") } }))
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return mockRes(200)
      }

      let armed = false
      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => {
          if (usageCalls > 0 && armed) controller.abort(abort)
          armed = usageCalls > 0
          return 1_000
        },
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      await expect(fetch("https://api.example.com/abort-after-usage", { signal: controller.signal })).rejects.toBe(abort)
      expect(upstreamAuth).toEqual([])
      expect(usageCalls).toBe(1)
      expect(state.activeIndex).toBe(1)
      expect(state.cooldownUntil.get(0)).toBe(61_000)
      expect(state.blocked.size).toBe(0)
    })

    it("propagates caller abort during advisory classification and does not send overage", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const abort = new Error("caller cancelled during classification")
      let cancelCalled = false
      let cloned: Response | undefined
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      const stream = new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          cancelCalled = true
          return new Promise(() => {})
        },
      })
      const stalled = new Response(stream, {
        status: 403,
        headers: { "content-type": "text/plain" },
      })
      const originalClone = stalled.clone.bind(stalled)
      let classificationStarted!: () => void
      const classificationReady = new Promise<void>((resolve) => {
        classificationStarted = resolve
      })
      stalled.clone = () => {
        cloned = originalClone()
        classificationStarted()
        return cloned
      }
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) return usageResponse()
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return requestHeaders(input, init).get("Authorization") === "Bearer key-primary"
          ? stalled
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
        inspectionTimeoutMs: 250,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      const controller = new AbortController()
      try {
        const pending = fetch("https://api.example.com/abort-classify", { signal: controller.signal })
        await classificationReady
        controller.abort(abort)
        await expect(pending).rejects.toBe(abort)
        expect(upstreamAuth).toEqual(["Bearer key-primary"])
        expect(cancelCalled).toBe(true)
        expect(cloned?.body?.locked).toBe(false)
        expect(stalled.body?.locked).toBe(false)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
        expect(state.activeIndex).toBe(1)
        expect(state.cooldownUntil.get(0)).toBe(61_000)
        expect(state.blocked.size).toBe(0)
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })

    it("cancels the current model response when caller aborts during post-response usage consultation", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
        mk("key-cooling", true, "cooling", "primary"),
      ]
      const abort = new Error("caller cancelled during post-response consult")
      const cancelSpy = spyReadableStreamCancel()
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      const quota = mockRes(429, "quota exceeded")
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageStarted()
          return usageGate
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return requestHeaders(input, init).get("Authorization") === "Bearer key-primary"
          ? quota
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 0
      state.cooldownUntil.set(2, 61_000)

      const controller = new AbortController()
      try {
        const pending = fetch("https://api.example.com/abort-post-response-consult", { signal: controller.signal })
        await usageReady
        controller.abort(abort)
        await expect(pending).rejects.toBe(abort)
        expect(upstreamAuth).toEqual(["Bearer key-primary"])
        expect(cancelSpy.calls).toBe(1)
        expect(quota.body?.locked).toBe(false)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
        expect(state.activeIndex).toBe(0)
        expect(state.blocked.size).toBe(0)
      } finally {
        cancelSpy.restore()
        process.off("unhandledRejection", onUnhandled)
        releaseUsage(usageResponse())
      }
    })

    it("rejects caller abort instead of returning a retained response when the final candidate is exhausted", async () => {
      const accounts = [
        mk("key-a", true, "a", "primary"),
        mk("key-b", true, "b", "primary"),
      ]
      const abort = new Error("caller cancelled before retained terminal return")
      const controller = new AbortController()
      let cancelCalls = 0
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      const retained = mockRes(401, "primary-auth-failure")
      retained.body!.cancel = () => {
        cancelCalls++
        return new Promise(() => {})
      }
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return requestHeaders(input, init).get("Authorization") === "Bearer key-a"
          ? retained
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: (_level, msg) => {
          if (msg === "credential rotation") {
            state.blocked.add(1)
            controller.abort(abort)
          }
        },
        now: () => 1_000,
        wait: async () => {
          throw new Error("unexpected wait")
        },
      })

      try {
        await expect(fetch("https://api.example.com/abort-retained-terminal", { signal: controller.signal })).rejects.toBe(abort)
        expect(upstreamAuth).toEqual(["Bearer key-a"])
        expect(cancelCalls).toBe(1)
        expect(retained.body?.locked).toBe(false)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
        expect(state.activeIndex).toBe(0)
        expect(state.blocked).toEqual(new Set([0, 1]))
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })

    it("cancels the retained response when caller aborts during pre-response usage consultation", async () => {
      const accounts = [
        mk("key-a", true, "a", "primary"),
        mk("key-b", true, "b", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
        mk("key-cooling", true, "cooling", "primary"),
      ]
      const abort = new Error("caller cancelled during pre-response consult")
      const controller = new AbortController()
      let cancelCalls = 0
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      const retained = mockRes(401, "primary-auth-failure")
      retained.body!.cancel = () => {
        cancelCalls++
        return new Promise(() => {})
      }
      let releaseUsage!: (response: Response) => void
      const usageGate = new Promise<Response>((resolve) => {
        releaseUsage = resolve
      })
      let usageStarted!: () => void
      const usageReady = new Promise<void>((resolve) => {
        usageStarted = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (isUsageRequest(input)) {
          usageStarted()
          return usageGate
        }
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return requestHeaders(input, init).get("Authorization") === "Bearer key-a"
          ? retained
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: (_level, msg) => {
          if (msg === "credential rotation") state.blocked.add(1)
        },
        now: () => 1_000,
        wait: async () => {
          throw new Error("unexpected wait")
        },
      })
      state.cooldownUntil.set(3, 61_000)

      try {
        const pending = fetch("https://api.example.com/abort-pre-response-consult", { signal: controller.signal })
        await usageReady
        controller.abort(abort)
        await expect(pending).rejects.toBe(abort)
        expect(upstreamAuth).toEqual(["Bearer key-a"])
        expect(cancelCalls).toBe(1)
        expect(retained.body?.locked).toBe(false)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
        expect(state.activeIndex).toBe(0)
        expect(state.blocked.has(0)).toBe(true)
        expect(state.blocked.has(1)).toBe(true)
      } finally {
        process.off("unhandledRejection", onUnhandled)
        releaseUsage(usageResponse())
      }
    })

    it("cancels the retained response when caller aborts during recovery wait", async () => {
      const accounts = [
        mk("key-a", true, "a", "primary"),
        mk("key-b", true, "b", "primary"),
        mk("key-cooling", true, "cooling", "primary"),
      ]
      const abort = new Error("caller cancelled during recovery wait")
      const controller = new AbortController()
      let cancelCalls = 0
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      const retained = mockRes(401, "primary-auth-failure")
      retained.body!.cancel = () => {
        cancelCalls++
        return new Promise(() => {})
      }
      let waitStarted!: () => void
      const waitReady = new Promise<void>((resolve) => {
        waitStarted = resolve
      })
      const upstreamAuth: string[] = []
      const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        upstreamAuth.push(requestHeaders(input, init).get("Authorization")!)
        return requestHeaders(input, init).get("Authorization") === "Bearer key-a"
          ? retained
          : mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: (_level, msg) => {
          if (msg === "credential rotation") state.blocked.add(1)
        },
        now: () => 1_000,
        wait: async (_delayMs, signal) => {
          waitStarted()
          return new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener("abort", onAbort)
              reject(signal.reason)
            }
            signal.addEventListener("abort", onAbort)
            if (signal.aborted) onAbort()
          })
        },
      })
      state.cooldownUntil.set(2, 61_000)

      try {
        const pending = fetch("https://api.example.com/abort-recovery-wait", { signal: controller.signal })
        await waitReady
        controller.abort(abort)
        await expect(pending).rejects.toBe(abort)
        expect(upstreamAuth).toEqual(["Bearer key-a"])
        expect(cancelCalls).toBe(1)
        expect(retained.body?.locked).toBe(false)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
        expect(state.activeIndex).toBe(0)
        expect(state.blocked.has(0)).toBe(true)
        expect(state.blocked.has(1)).toBe(true)
        expect(state.cooldownUntil.get(2)).toBe(61_000)
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })

    for (const testCase of [
      {
        name: "ordinary",
        error: new TypeError("ordinary transport"),
        setup(state: { activeIndex: number; blocked: Set<number>; cooldownUntil: Map<number, number> }) {
          state.activeIndex = 0
        },
      },
      {
        name: "advisory",
        error: new TypeError("advisory transport"),
        setup(state: { activeIndex: number; blocked: Set<number>; cooldownUntil: Map<number, number> }) {
          state.activeIndex = 1
          state.cooldownUntil.set(0, 61_000)
        },
      },
    ]) {
      it(`preserves the original ${testCase.name} model transport error when concurrent invalidation leaves no response`, async () => {
        const accounts = [
          mk("key-primary", true, "primary", "primary"),
          mk("key-overage", true, "overage", "overage_fallback"),
        ]
        const upstreamAuth: string[] = []
        const { fetch, state } = createRotatingFetch(accounts, -1, async (input, init) => {
          if (isUsageRequest(input)) return usageResponse()
          const authorization = requestHeaders(input, init).get("Authorization")!
          upstreamAuth.push(authorization)
          if (authorization === "Bearer key-primary") {
            state.blocked.add(0)
            state.blocked.add(1)
            throw testCase.error
          }
          return mockRes(200)
        }, {
          logger: quietLogger,
          now: () => 1_000,
        })
        testCase.setup(state)

        await expect(fetch("https://api.example.com/transport-no-response")).rejects.toBe(testCase.error)
        expect(upstreamAuth).toEqual(["Bearer key-primary"])
        expect(state.blocked).toEqual(new Set([0, 1]))
      })
    }

    it("removes the caller abort listener after usage lookup settles", async () => {
      const accounts = [
        mk("key-primary", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const baseFetch = async (input: RequestInfo | URL) => {
        if (isUsageRequest(input)) return usageResponse()
        return mockRes(200)
      }

      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: quietLogger,
        now: () => 1_000,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      const controller = new AbortController()
      expect((await fetch("https://api.example.com/abort-cleanup", { signal: controller.signal })).status).toBe(200)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    })

    it("warns once per account when useBalance is enabled", async () => {
      const accounts = [
        mk("secret-primary-key", true, "primary", "primary"),
        mk("key-overage", true, "overage", "overage_fallback"),
      ]
      const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = []
      const baseFetch = async (input: RequestInfo | URL) => {
        if (isUsageRequest(input)) return usageResponse(usageBody({ useBalance: true, usage: { rolling: usageWindow("rate-limited") } }))
        return mockRes(200)
      }

      let now = 1_000
      const { fetch, state } = createRotatingFetch(accounts, -1, baseFetch, {
        logger: (level, msg, data) => {
          if (level === "warn") warnings.push({ msg, data })
        },
        now: () => now,
      })
      state.activeIndex = 1
      state.cooldownUntil.set(0, 61_000)

      expect((await fetch("https://api.example.com/balance-1")).status).toBe(200)
      now = 6_001
      expect((await fetch("https://api.example.com/balance-2")).status).toBe(200)
      const balanceWarnings = warnings.filter(({ msg }) => /use balance/i.test(msg))
      expect(balanceWarnings).toHaveLength(1)
      expect(JSON.stringify(balanceWarnings)).not.toContain("secret-primary-key")
    })
  })
})
