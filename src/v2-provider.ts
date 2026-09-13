import { AsyncLocalStorage } from "node:async_hooks"
import { LanguageModel, LLMRequest, type ProviderPackageDefinition, type ProviderPackageSettings } from "@opencode/ai"
import { model as anthropicModel } from "@opencode/ai/providers/anthropic"
import { model as openAIModel } from "@opencode/ai/providers/openai"
import { model as openAICompatibleModel } from "@opencode/ai/providers/openai-compatible"
import type { HttpMiddleware } from "@opencode/ai/route/executor"
import { Effect, Stream } from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { FetchFn } from "./fetch.js"
import {
  NATIVE_PACKAGE_SETTING,
  USAGE_URL,
  type V2NativePackage,
} from "./opencode.js"
import { initializeRotation } from "./runtime.js"

export { NATIVE_PACKAGE_SETTING } from "./opencode.js"

type NativeModel = (modelID: string, settings: ProviderPackageSettings) => LanguageModel

const nativeModels = new Map<V2NativePackage, NativeModel>([
  ["aisdk:@ai-sdk/anthropic", (modelID, settings) => anthropicModel(modelID, settings as any) as LanguageModel],
  ["aisdk:@ai-sdk/openai", (modelID, settings) => openAIModel(modelID, settings as any) as LanguageModel],
  ["aisdk:@ai-sdk/openai-compatible", (modelID, settings) =>
    openAICompatibleModel(modelID, settings as any) as LanguageModel],
])

type Rotation = NonNullable<ReturnType<typeof initializeRotation>>
type RotationTransport = Pick<Rotation, "fetch">
type CredentialHeader = "authorization" | "x-api-key"
interface RequestScope {
  getStore(): FetchFn | undefined
  run<T>(store: FetchFn, callback: () => T): T
}

const requestFetch = new AsyncLocalStorage<FetchFn>()
let sharedRotation: Rotation | undefined

function rotation() {
  sharedRotation ??= initializeRotation((input, init) => {
    const execute = requestFetch.getStore()
    if (!execute) throw new Error("OpenCode Go HTTP handler is unavailable")
    return execute(input, init)
  })
  if (!sharedRotation) throw new Error("No enabled OpenCode Go accounts are configured")
  return sharedRotation
}

function responseHeaders(response: HttpClientResponse.HttpClientResponse) {
  return Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, String(value)]))
}

function applyCredential(request: Request, credentialHeader: CredentialHeader) {
  const headers = new Headers(request.headers)
  const authorization = headers.get("authorization")
  const key = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined
  headers.delete("authorization")
  headers.delete("x-api-key")
  if (key !== undefined) {
    if (request.url === USAGE_URL || credentialHeader === "authorization") {
      headers.set("authorization", `Bearer ${key}`)
    } else {
      headers.set("x-api-key", key)
    }
  }
  return new Request(request, { headers })
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal) {
  if (primary === secondary) return { signal: primary, cleanup() {} }

  const controller = new AbortController()
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason)
  }
  const onPrimaryAbort = () => abortFrom(primary)
  const onSecondaryAbort = () => abortFrom(secondary)
  primary.addEventListener("abort", onPrimaryAbort, { once: true })
  secondary.addEventListener("abort", onSecondaryAbort, { once: true })
  if (primary.aborted) abortFrom(primary)
  else if (secondary.aborted) abortFrom(secondary)

  return {
    signal: controller.signal,
    cleanup() {
      primary.removeEventListener("abort", onPrimaryAbort)
      secondary.removeEventListener("abort", onSecondaryAbort)
    },
  }
}

export function createRotatingMiddleware(
  runtime: RotationTransport,
  credentialHeader: CredentialHeader = "authorization",
  scope: RequestScope = requestFetch,
): HttpMiddleware {
  return (request, handler) =>
    Effect.tryPromise({
      async try(signal) {
        const requests = new WeakMap<Response, HttpClientRequest.HttpClientRequest>()
        const execute: FetchFn = async (input, init) => {
          const attempt = applyCredential(new Request(input, init), credentialHeader)
          const next = HttpClientRequest.fromWeb(attempt)

          const combined = combineAbortSignals(signal, attempt.signal)
          let response: HttpClientResponse.HttpClientResponse
          try {
            response = await Effect.runPromise(handler(next), { signal: combined.signal })
          } finally {
            combined.cleanup()
          }
          const headers = responseHeaders(response)
          const body = attempt.method === "HEAD" || response.status === 204 || response.status === 205
            || response.status === 304
            ? null
            : Stream.toReadableStream(response.stream.pipe(
                Stream.catchIf(
                  (error) => HttpClientError.isHttpClientError(error) && error.reason._tag === "EmptyBodyError",
                  () => Stream.empty,
                ),
              ))
          const web = new Response(body, { status: response.status, headers })
          requests.set(web, next)
          return web
        }

        const webRequest = await Effect.runPromise(HttpClientRequest.toWeb(request), { signal })
        const template = new Request(webRequest, { signal })
        const response = await scope.run(execute, () => runtime.fetch(template))
        const responseRequest = requests.get(response)
        if (!responseRequest) throw new Error("OpenCode Go rotation returned an unknown response")
        return HttpClientResponse.fromWeb(responseRequest, response)
      },
      catch: toError,
    })
}

function decorate(model: LanguageModel, credentialHeader: CredentialHeader) {
  const transport = model.route.transport
  const rotating = createRotatingMiddleware(rotation(), credentialHeader)
  const decorated: typeof transport = {
    ...transport,
    prepare(input) {
      const hostMiddleware = input.middleware
      // OpenCode wraps package models in its own runtime. Native transports must see
      // a package-local model while retaining the host's selected model semantics.
      const request = input.request.model instanceof LanguageModel
        ? input.request
        : LLMRequest.update(input.request, {
            model: LanguageModel.make(LanguageModel.input(input.request.model)),
          })
      return transport.prepare({
        ...input,
        request,
        middleware(request, handler) {
          return rotating(request, (attempt) => hostMiddleware ? hostMiddleware(attempt, handler) : handler(attempt))
        },
      })
    },
  }
  return LanguageModel.update(model, { route: model.route.with({ transport: decorated }) })
}

export const model: ProviderPackageDefinition["model"] = (modelID, settings: ProviderPackageSettings) => {
  const { [NATIVE_PACKAGE_SETTING]: nativePackage, ...nativeSettings } = settings
  const nativeModel = typeof nativePackage === "string"
    ? nativeModels.get(nativePackage as V2NativePackage)
    : undefined
  if (!nativeModel) {
    throw new Error(`Unsupported OpenCode Go native provider package: ${String(nativePackage)}`)
  }
  return decorate(
    nativeModel(modelID, nativeSettings),
    nativePackage === "aisdk:@ai-sdk/anthropic" ? "x-api-key" : "authorization",
  )
}
