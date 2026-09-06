import { describe, it, expect } from "bun:test"
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
})
