import { AsyncLocalStorage } from "node:async_hooks"
import { getEventListeners } from "node:events"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Effect, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HttpOptions, LanguageModel, LLMRequest } from "@opencode/ai"
import { model as nativeAnthropicModel } from "@opencode/ai/providers/anthropic"
import type { FetchFn } from "../fetch"
import { saveAccounts, saveRotationState } from "../storage"
import type { GoAccount } from "../types"

const originalHome = process.env.HOME
let tmpHome: string
let createRotatingFetch: typeof import("../fetch").createRotatingFetch
let provider: typeof import("../v2-provider")

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "go-v2-provider-test-"))
  process.env.HOME = tmpHome
  createRotatingFetch = (await import("../fetch")).createRotatingFetch
  provider = await import("../v2-provider")
})

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

function account(apiKey: string, role: GoAccount["role"] = "primary"): GoAccount {
  return { apiKey, addedAt: apiKey.charCodeAt(0), enabled: true, role }
}

function nativeRequest(signal?: AbortSignal) {
  const web = new Request("https://upstream.example/v1/chat/completions?trace=1", {
    method: "POST",
    headers: {
      Authorization: "Bearer host-key",
      "Content-Type": "application/json",
      "X-Request-ID": "request-1",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    signal,
  })
  return HttpClientRequest.fromWeb(web)
}

function harness(
  accounts: GoAccount[],
  respond: (request: Request, attempt: number) => Response | Promise<Response>,
  credentialHeader: "authorization" | "x-api-key" = "authorization",
) {
  const scope = new AsyncLocalStorage<FetchFn>()
  const calls: Request[] = []
  const rotating = createRotatingFetch(
    accounts,
    -1,
    (input, init) => {
      const execute = scope.getStore()
      if (!execute) throw new Error("missing test HTTP handler")
      return execute(input, init)
    },
    { logger() {}, inspectionTimeoutMs: 20 },
  )
  const middleware = provider.createRotatingMiddleware(rotating, credentialHeader, scope)
  const handler = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.tryPromise({
      async try() {
        const web = await Effect.runPromise(HttpClientRequest.toWeb(request))
        calls.push(web)
        return HttpClientResponse.fromWeb(request, await respond(web, calls.length))
      },
      catch: (error) => error as Error,
    })

  return {
    calls,
    middleware,
    request: () => Effect.runPromise(middleware(nativeRequest(), handler)),
    state: rotating.state,
  }
}

function within<T>(promise: Promise<T>, timeoutMs = 100) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("operation timed out")), timeoutMs)),
  ])
}

describe("OpenCode V2 native provider transport", () => {
  it("returns a single successful native response without replaying", async () => {
    const test = harness([account("a")], () => new Response("success", { status: 200 }))

    const response = await test.request()

    expect(response.status).toBe(200)
    expect(await Effect.runPromise(response.text)).toBe("success")
    expect(test.calls.map((request) => request.headers.get("authorization"))).toEqual(["Bearer a"])
  })

  it("preserves an empty successful native response", async () => {
    const test = harness([account("a")], () => new Response(null, { status: 200 }))

    const response = await test.request()

    expect(response.status).toBe(200)
    expect(await Effect.runPromise(response.text)).toBe("")
  })

  it("fails over from A to B within one native operation", async () => {
    const test = harness(
      [account("a"), account("b")],
      (_request, attempt) => attempt === 1
        ? Response.json({ error: { type: "authentication_error", message: "invalid key" } }, { status: 401 })
        : new Response("success", { status: 200 }),
    )

    const response = await test.request()

    expect(response.status).toBe(200)
    expect(test.calls.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer a",
      "Bearer b",
    ])
    expect(test.state.activeIndex).toBe(1)
  })

  it("replaces Anthropic x-api-key credentials on every prepared retry", async () => {
    const model = nativeAnthropicModel("messages-model", {
      apiKey: "host-key",
      baseURL: "https://upstream.example/anthropic",
    })
    const scope = new AsyncLocalStorage<FetchFn>()
    const rotating = createRotatingFetch(
      [account("a"), account("b")],
      -1,
      (input, init) => scope.getStore()!(input, init),
      { logger() {} },
    )
    const middleware = provider.createRotatingMiddleware(rotating, "x-api-key", scope)
    const prepared = await Effect.runPromise(model.route.transport.prepare({
      body: { messages: [] },
      request: new LLMRequest({ model, system: [], messages: [], tools: [] }),
      endpoint: model.route.endpoint,
      auth: model.route.auth,
      encodeBody: JSON.stringify,
      headers: model.route.headers,
      middleware,
    }))
    const credentials: Array<[string | undefined, string | undefined]> = []

    const response = await Effect.runPromise(prepared.middleware!(prepared.request, (request) => {
      credentials.push([request.headers["x-api-key"], request.headers.authorization])
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(credentials.length === 1 ? "invalid key" : "success", {
          status: credentials.length === 1 ? 401 : 200,
        }),
      ))
    }))

    expect(response.status).toBe(200)
    expect(credentials).toEqual([["a", undefined], ["b", undefined]])
  })

  it("uses bearer credentials for the OpenCode usage host under Anthropic transport", async () => {
    const test = harness(
      [account("a"), account("b", "overage_fallback")],
      (request) => request.url === "https://opencode.ai/zen/go/v1/usage"
        ? Response.json({
            usage: {
              rolling: { status: "ok", percent: 10, resetsAt: "2026-08-13T16:27:38.287Z" },
              weekly: { status: "ok", percent: 10, resetsAt: "2026-08-13T16:27:38.287Z" },
              monthly: { status: "ok", percent: 10, resetsAt: "2026-08-13T16:27:38.287Z" },
            },
          })
        : new Response("success", { status: 200 }),
      "x-api-key",
    )
    test.state.activeIndex = 1
    test.state.cooldownUntil.set(0, Date.now() + 60_000)

    expect((await test.request()).status).toBe(200)
    expect(test.calls.map((request) => ({
      url: request.url,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
    }))).toEqual([
      {
        url: "https://opencode.ai/zen/go/v1/usage",
        authorization: "Bearer a",
        apiKey: null,
      },
      {
        url: "https://upstream.example/v1/chat/completions?trace=1",
        authorization: null,
        apiKey: "a",
      },
    ])
  })

  it("fast-paths a stalled 401 body and fails over", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stalled = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    })
    const test = harness([account("a"), account("b")], (_request, attempt) => attempt === 1
      ? new Response(stalled, { status: 401 })
      : new Response("success", { status: 200 }))

    try {
      expect((await within(test.request())).status).toBe(200)
      expect(test.calls).toHaveLength(2)
    } finally {
      try {
        controller?.close()
      } catch {}
    }
  })

  it("returns an oversized unclassified body without eagerly reading it", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const oversized = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    })
    const test = harness([account("a"), account("b")], () => new Response(oversized, {
      status: 429,
      headers: {
        "content-length": String(65 * 1024),
        "content-type": "text/plain",
      },
    }))

    try {
      expect((await within(test.request())).status).toBe(429)
      expect(test.calls).toHaveLength(1)
    } finally {
      try {
        controller?.close()
      } catch {}
    }
  })

  it("preserves usage response bodies for advisory primary recovery", async () => {
    const test = harness(
      [account("a"), account("b", "overage_fallback")],
      (request) => request.url === "https://opencode.ai/zen/go/v1/usage"
        ? Response.json({
            usage: {
              rolling: { status: "ok", percent: 10, resetsAt: "2026-08-13T16:27:38.287Z" },
              weekly: { status: "ok", percent: 10, resetsAt: "2026-08-13T16:27:38.287Z" },
              monthly: { status: "ok", percent: 10, resetsAt: "2026-08-13T16:27:38.287Z" },
            },
          })
        : new Response("success", { status: 200 }),
    )
    test.state.activeIndex = 1
    test.state.cooldownUntil.set(0, Date.now() + 60_000)

    expect((await test.request()).status).toBe(200)
    expect(test.calls.map((request) => request.url)).toEqual([
      "https://opencode.ai/zen/go/v1/usage",
      "https://upstream.example/v1/chat/completions?trace=1",
    ])
    expect(test.calls.at(-1)?.headers.get("authorization")).toBe("Bearer a")
  })

  it("does not cap failover at five attempts", async () => {
    const accounts = "abcdefg".split("").map(account)
    const test = harness(accounts, (_request, attempt) =>
      attempt < accounts.length
        ? new Response("invalid key", { status: 401 })
        : new Response("success", { status: 200 }))

    expect((await test.request()).status).toBe(200)
    expect(test.calls.map((request) => request.headers.get("authorization"))).toEqual(
      accounts.map(({ apiKey }) => `Bearer ${apiKey}`),
    )
  })

  it("preserves the native request body, URL, method, and non-auth headers", async () => {
    const bodies: string[] = []
    const test = harness([account("a"), account("b")], async (request, attempt) => {
      bodies.push(await request.text())
      return new Response(attempt === 1 ? "invalid key" : "success", {
        status: attempt === 1 ? 401 : 200,
      })
    })

    expect((await test.request()).status).toBe(200)
    expect(bodies).toEqual([
      JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    ])
    for (const request of test.calls) {
      expect(request.url).toBe("https://upstream.example/v1/chat/completions?trace=1")
      expect(request.method).toBe("POST")
      expect(request.headers.get("content-type")).toBe("application/json")
      expect(request.headers.get("x-request-id")).toBe("request-1")
    }
  })

  it("keeps the successful account sticky for the next operation", async () => {
    let attempt = 0
    const test = harness([account("a"), account("b")], () => {
      attempt++
      return new Response(attempt === 1 ? "invalid key" : "success", {
        status: attempt === 1 ? 401 : 200,
      })
    })

    expect((await test.request()).status).toBe(200)
    expect((await test.request()).status).toBe(200)
    expect(test.calls.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer a",
      "Bearer b",
      "Bearer b",
    ])
  })

  it("propagates cancellation to the supplied native handler", async () => {
    const scope = new AsyncLocalStorage<FetchFn>()
    const rotating = createRotatingFetch(
      [account("a")],
      -1,
      (input, init) => scope.getStore()!(input, init),
      { logger() {} },
    )
    const middleware = provider.createRotatingMiddleware(rotating, "authorization", scope)
    const interrupted = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const handler = () => Effect.sync(() => started.resolve()).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
    )
    const controller = new AbortController()

    const pending = Effect.runPromise(middleware(nativeRequest(), handler), { signal: controller.signal })
    await started.promise
    controller.abort(new Error("caller cancelled"))

    await expect(pending).rejects.toThrow()
    await interrupted.promise
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })

  it("interrupts the native handler when a per-attempt request is aborted", async () => {
    const scope = new AsyncLocalStorage<FetchFn>()
    const attemptController = new AbortController()
    const runtime = {
      fetch: async () => scope.getStore()!(new Request("https://opencode.ai/zen/go/v1/usage", {
        signal: attemptController.signal,
      })),
    }
    const middleware = provider.createRotatingMiddleware(runtime, "authorization", scope)
    const interrupted = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const handler = () => Effect.sync(() => started.resolve()).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
    )

    const pending = Effect.runPromise(middleware(nativeRequest(), handler))
    await started.promise
    attemptController.abort(new DOMException("usage lookup timed out", "AbortError"))

    await expect(within(pending)).rejects.toThrow()
    await within(interrupted.promise)
    expect(getEventListeners(attemptController.signal, "abort")).toHaveLength(0)
  })

  it("preserves unrelated stream errors that resemble EmptyBodyError", async () => {
    const test = harness([account("a")], () => new Response("unused"))
    const unrelated = { reason: { _tag: "EmptyBodyError" }, marker: "unrelated" }
    const response = await Effect.runPromise(test.middleware(nativeRequest(), (request) => {
      const base = HttpClientResponse.fromWeb(request, new Response("unused"))
      return Effect.succeed(Object.create(base, {
        stream: { value: Stream.fail(unrelated) },
      }) as typeof base)
    }))

    await expect(Effect.runPromise(response.text)).rejects.toMatchObject({
      reason: { _tag: "DecodeError", cause: unrelated },
    })
  })

  it("rejects prototype-chain native package names as unsupported", () => {
    expect(() => provider.model("chat-model", {
      [provider.NATIVE_PACKAGE_SETTING]: "toString",
    })).toThrow("Unsupported OpenCode Go native provider package: toString")
  })

  it("localizes a foreign host-updated Anthropic model without losing host semantics", async () => {
    saveAccounts({ version: 1, accounts: [account("a"), account("b")], rotationIndex: 0 })
    saveRotationState({ lastUsedIndex: -1 })
    const original = provider.model("closed-over-model", {
      [provider.NATIVE_PACKAGE_SETTING]: "aisdk:@ai-sdk/anthropic",
      apiKey: "host-key",
      baseURL: "https://opencode.ai/zen/go/v1",
    })
    const hostRoute = original.route.with({
      provider: "opencode-go",
      providerMetadataKey: "opencode-go",
      headers: { "x-host-route-setting": "kept" },
    })
    class ForeignLanguageModel {
      constructor(input: Record<string, unknown>) {
        Object.assign(this, input)
      }
    }
    class ForeignLLMRequest {
      constructor(input: Record<string, unknown>) {
        Object.assign(this, input)
      }
    }
    const foreignModel = new ForeignLanguageModel({
      ...LanguageModel.input(original),
      id: "host-selected-model",
      provider: "opencode-go",
      route: hostRoute,
      defaults: {
        providerOptions: { hostDefault: "kept" },
        http: { headers: { "x-host-default": "kept" } },
      },
      compatibility: {
        requireSignature: false,
        supportsThinkingBlockBinding: false,
      },
    }) as unknown as LanguageModel
    const providerOptions = { hostRequestOption: "kept" }
    const metadata = { hostMetadata: "kept" }
    const hostRequest = new ForeignLLMRequest({
      id: "host-request-id",
      model: foreignModel,
      system: [],
      messages: [],
      tools: [],
      providerOptions,
      http: new HttpOptions({ headers: { "x-host-request": "kept" } }),
      cache: "none",
      promptCacheKey: "host-cache-key",
      metadata,
    }) as unknown as LLMRequest
    let localizedRequest: LLMRequest | undefined
    const endpoint = {
      ...hostRoute.endpoint,
      path(input: Parameters<Exclude<typeof hostRoute.endpoint.path, string>>[0]) {
        localizedRequest = input.request
        return typeof hostRoute.endpoint.path === "function"
          ? hostRoute.endpoint.path(input)
          : hostRoute.endpoint.path
      },
    }

    const prepared = await Effect.runPromise(hostRoute.transport.prepare({
      body: { messages: [] },
      request: hostRequest,
      endpoint,
      auth: hostRoute.auth,
      encodeBody: JSON.stringify,
      headers: ({ request }) => ({
        ...hostRoute.headers?.({ request }),
        "x-host-deployment": "kept",
      }),
    }))

    expect(foreignModel).not.toBeInstanceOf(LanguageModel)
    expect(localizedRequest?.model).toBeInstanceOf(LanguageModel)
    expect(localizedRequest?.model.constructor).toBe(LanguageModel)
    expect(localizedRequest?.model).not.toBe(original)
    expect(localizedRequest?.model.id).toBe("host-selected-model")
    expect(localizedRequest?.model.provider).toBe("opencode-go")
    expect(localizedRequest?.model.route).toBe(hostRoute)
    expect(localizedRequest?.model.route.defaults.http?.headers).toEqual({ "x-host-route-setting": "kept" })
    expect(localizedRequest?.model.defaults?.providerOptions).toEqual({ hostDefault: "kept" })
    expect(localizedRequest?.model.defaults?.http?.headers).toEqual({ "x-host-default": "kept" })
    expect(localizedRequest?.model.compatibility?.requireSignature).toBe(false)
    expect(localizedRequest?.model.compatibility?.supportsThinkingBlockBinding).toBe(false)
    expect(localizedRequest?.id).toBe("host-request-id")
    expect(localizedRequest?.providerOptions).toEqual(providerOptions)
    expect(localizedRequest?.http?.headers["x-host-request"]).toBe("kept")
    expect(localizedRequest?.cache).toBe("none")
    expect(localizedRequest?.promptCacheKey).toBe("host-cache-key")
    expect(localizedRequest?.metadata).toEqual(metadata)
    expect(prepared.request.url).toBe("https://opencode.ai/zen/go/v1/messages")
    expect(prepared.request.headers["x-host-request"]).toBe("kept")
    expect(prepared.request.headers["x-host-deployment"]).toBe("kept")
  })

  it("preserves native protocol overrides and composes host middleware on every retry", async () => {
    saveAccounts({ version: 1, accounts: [account("a"), account("b")], rotationIndex: 0 })
    saveRotationState({ lastUsedIndex: -1 })
    const compatible = provider.model("chat-model", {
      [provider.NATIVE_PACKAGE_SETTING]: "aisdk:@ai-sdk/openai-compatible",
      apiKey: "host-key",
      baseURL: "https://upstream.example/v1",
    })
    const anthropic = provider.model("messages-model", {
      [provider.NATIVE_PACKAGE_SETTING]: "aisdk:@ai-sdk/anthropic",
      apiKey: "host-key",
      baseURL: "https://upstream.example/anthropic",
    })
    const openai = provider.model("responses-model", {
      [provider.NATIVE_PACKAGE_SETTING]: "aisdk:@ai-sdk/openai",
      apiKey: "host-key",
      baseURL: "https://upstream.example/openai",
    })

    expect(compatible.route.id).toBe("openai-compatible-chat")
    expect(anthropic.route.id).toBe("anthropic-messages")
    expect(openai.route.id).toBe("openai-responses")

    const middlewareCalls: string[] = []
    const handlerSentinels: string[] = []
    const hostMiddleware = (request: HttpClientRequest.HttpClientRequest, handler: any) => {
      middlewareCalls.push(request.headers.authorization ?? "")
      return handler(HttpClientRequest.setHeader(request, "x-host-sentinel", "composed"))
    }
    const prepared = await Effect.runPromise(compatible.route.transport.prepare({
      body: {},
      request: new LLMRequest({ model: compatible, system: [], messages: [], tools: [] }),
      endpoint: compatible.route.endpoint,
      auth: compatible.route.auth,
      encodeBody: JSON.stringify,
      headers: compatible.route.headers,
      middleware: hostMiddleware,
    }))
    let attempt = 0
    const response = await Effect.runPromise(prepared.middleware!(prepared.request, (request) => {
      attempt++
      handlerSentinels.push(request.headers["x-host-sentinel"] ?? "")
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(attempt === 1 ? "invalid key" : "success", {
          status: attempt === 1 ? 401 : 200,
        }),
      ))
    }))

    expect(response.status).toBe(200)
    expect(middlewareCalls).toEqual(["Bearer a", "Bearer b"])
    expect(handlerSentinels).toEqual(["composed", "composed"])
  })
})
