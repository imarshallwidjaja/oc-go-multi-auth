// OpenCode 2 server plugin: session hooks for rotation and the account RPC.
import type { Plugin } from "@opencode/plugin"
import {
  AccountInputError,
  addAccount,
  listAccounts,
  removeAccount,
  setAccountRole,
} from "./accounts.js"
import { log } from "./logger.js"
import { GoAccountsRpc } from "./rpc.js"
import type { AccountPool } from "./pool.js"
import { initializeAccountPool } from "./runtime.js"
import { AccountsBusyError, AccountsCorruptError } from "./storage.js"
import { baseURLOf, endpointWithin, isUnresolved, originOf, parseEndpoint } from "./destination.js"
import { createV2Transport, type Destination, type V2Transport } from "./v2-transport.js"
import { collectStoredAccountUsage } from "./usage.js"

export const PROVIDER_ID = "opencode-go"
const SUPPORTED_RANGE = ">=2.0.28 <3"

type Context = Plugin.Context
type Registration = { dispose(): Promise<void> }

// OpenCode 2 can run one plugin instance per location in the same process.
// They share one pool, so cooldowns and stickiness agree and the startup
// snapshot is read once; the last instance to clean up disposes it.
let shared: { pool: AccountPool; users: number } | undefined

function acquirePool() {
  if (!shared) {
    const pool = initializeAccountPool()
    if (!pool) return
    shared = { pool, users: 0 }
  }
  const entry = shared
  entry.users++
  let released = false
  return {
    pool: entry.pool,
    release() {
      if (released) return
      released = true
      entry.users--
      if (entry.users > 0) return
      entry.pool.dispose()
      if (shared === entry) shared = undefined
    },
  }
}

/** Distinguishes the OpenCode 1.x preview loader, which also calls setup(), from an unsupported V2 host. */
function hostSupport(ctx: Partial<Context> & { catalog?: unknown }) {
  if (!("app" in ctx) && !("session" in ctx) && "catalog" in ctx) return "v1-preview" as const
  const version = ctx.app?.version
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null
  // Development and snapshot builds report 0.0.0-*; only their capabilities can be checked.
  if (match && match[1] !== "0") {
    const [major, minor, patch] = match.slice(1).map(Number)
    if (major !== 2 || (minor === 0 && patch < 28)) return `OpenCode ${version}` as const
  }
  const capable = typeof ctx.session?.hook === "function"
    && typeof ctx.rpc?.register === "function"
    && typeof ctx.provider?.get === "function"
    && typeof ctx.integration?.connection?.active === "function"
    && typeof ctx.integration?.connect?.key === "function"
  if (!capable) return `an OpenCode host without session hooks, RPC, provider lookup or key connections (version ${String(version)})` as const
  return "supported" as const
}

function redact(message: string, secret: string) {
  return secret ? message.split(secret).join("[redacted]") : message
}

type ProviderInfo = Awaited<ReturnType<Context["provider"]["get"]>>["data"]
type ModelListing = Awaited<ReturnType<Context["model"]["list"]>>["data"]

/**
 * Finds the base URLs the host's Go configuration gives a model: its selected
 * variant's, then its own. Reads the public model list, which already merges
 * the catalog with the user's overrides.
 */
async function modelBaseURLs(ctx: Context, model: Destination["model"]) {
  if (typeof ctx.model?.list !== "function") return []
  const listing: ModelListing = (await ctx.model.list()).data
  const info = listing.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id)
  if (!info) return []
  const variant = model.variant === undefined ? undefined : info.variants.find((candidate) => candidate.id === model.variant)
  return [baseURLOf(variant?.settings), baseURLOf(info.settings)].filter((value): value is string => value !== undefined)
}

/**
 * Explains why a request's destination is not one the host configured for
 * OpenCode Go, or returns undefined when it is. Messages carry origins only,
 * never paths, queries, or values that could hold secrets.
 */
async function destinationReason(ctx: Context, provider: ProviderInfo, destination: Destination) {
  const target = parseEndpoint(destination.url)
  const origin = originOf(destination.url) ?? "an unreadable URL"
  if (!target) return `OpenCode Go's request destination (${origin}) is not a plain http(s) or ws(s) URL.`
  let unresolved = false
  let configured = false
  const matches = (base: string | undefined) => {
    if (base === undefined) return false
    configured = true
    const endpoint = parseEndpoint(base)
    if (!endpoint) unresolved ||= isUnresolved(base)
    return endpoint !== undefined && endpointWithin(endpoint, target)
  }
  const providerBase = baseURLOf(provider.settings)
  if (matches(providerBase)) return
  // The model or its selected variant may carry its own base URL.
  const bases = await modelBaseURLs(ctx, destination.model)
  // The model list was read after the provider; both must still describe the same configuration.
  const current = (await ctx.provider.get({ providerID: PROVIDER_ID })).data
  if (String(current.integrationID ?? current.id) !== PROVIDER_ID || baseURLOf(current.settings) !== providerBase) {
    return "OpenCode Go's configuration changed while its request destination was checked."
  }
  if (bases.some(matches)) return
  if (unresolved) {
    return `A base URL configured for OpenCode Go contains an unresolved \${...} variable, so the request to ${origin} cannot be matched to it.`
  }
  if (!configured) {
    return `OpenCode Go has no base URL configured for ${destination.model.id}, so the request to ${origin} cannot be matched to it.`
  }
  return `The request to ${origin} is not under a base URL configured for OpenCode Go (${destination.model.id}); rotation does not follow routing set by model request hooks.`
}

/**
 * Decides whether the pool may carry opencode-go requests. A provider rebound
 * to another integration, such as a Console one, belongs to that integration:
 * the pool's personal keys must never reach its gateway. Given a destination it
 * also requires the request to go where the host's current Go configuration
 * sends it, because a request prepared for one integration's gateway can
 * outlive a rebind. The host is read at every call because a reload can change
 * either at any time.
 */
function createAuthorization(ctx: Context) {
  let reported: string | undefined
  /** Returns why the pool must stay out, or undefined when it may carry the request. */
  return async (destination?: Destination) => {
    let reason: string | undefined
    try {
      const { data } = await ctx.provider.get({ providerID: PROVIDER_ID })
      const owner = String(data.integrationID ?? data.id)
      if (owner !== PROVIDER_ID) {
        reason = `OpenCode Go is bound to the "${owner}" integration, which account rotation does not support.`
      } else if (destination) {
        reason = await destinationReason(ctx, data, destination)
      }
    } catch (error) {
      reason = `OpenCode Go could not be inspected (${error instanceof Error ? error.message : String(error)}).`
    }
    if (reason !== reported) {
      reported = reason
      if (reason) log("warn", "rotation inactive", { reason })
    }
    return reason
  }
}

type Authorization = ReturnType<typeof createAuthorization>

/** Connects the host's opencode-go integration once, only when it has no active connection. */
async function activate(ctx: Context, authorization: Authorization, key: string) {
  try {
    const unsupported = await authorization()
    if (unsupported) return { status: "unsupported" as const, message: unsupported }
    if (await ctx.integration.connection.active(PROVIDER_ID)) return { status: "already_connected" as const }
    await ctx.integration.connect.key({ integrationID: PROVIDER_ID, key })
    return { status: "activated" as const }
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), key)
    log("warn", "integration activation failed", { error: message })
    return { status: "failed" as const, message }
  }
}

/** Returns the display-safe message of an expected failure; anything else propagates as an internal error. */
function rejection(error: unknown) {
  if (error instanceof AccountInputError || error instanceof AccountsBusyError || error instanceof AccountsCorruptError) {
    return error.message
  }
  throw error
}

function field(input: unknown, name: string) {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>)[name] : undefined
}

function idOf(input: unknown) {
  const id = field(input, "id")
  if (typeof id !== "string" || !id) throw new AccountInputError("An account id is required.")
  return id
}

function registerRpc(ctx: Context, authorization: Authorization) {
  return ctx.rpc.register(GoAccountsRpc, {
    list: async () => ({ accounts: listAccounts() }),
    add: async (input, context) => {
      try {
        const { account, count } = await addAccount({
          apiKey: field(input, "apiKey"),
          label: field(input, "label"),
          role: field(input, "role"),
        })
        const key = String(field(input, "apiKey")).trim()
        return { account, count, activation: await activate(ctx, authorization, key) }
      } catch (error) {
        return context.error("rejected", rejection(error), {})
      }
    },
    setRole: async (input, context) => {
      try {
        return { account: await setAccountRole({ id: idOf(input) }, field(input, "role")) }
      } catch (error) {
        return context.error("rejected", rejection(error), {})
      }
    },
    remove: async (input, context) => {
      try {
        return { account: await removeAccount({ id: idOf(input) }) }
      } catch (error) {
        return context.error("rejected", rejection(error), {})
      }
    },
    usage: async (_input, context) => {
      const rows = await collectStoredAccountUsage({ signal: context.signal })
      // Explicit copy: only display-safe fields cross the RPC boundary.
      return {
        rows: rows.map((row) => {
          const account = { label: row.account.label, role: row.account.role }
          if (row.kind === "disabled") return { kind: row.kind, index: row.index, account }
          if (row.kind === "error") {
            return { kind: row.kind, index: row.index, account, keyHint: row.keyHint, error: row.error }
          }
          return { kind: row.kind, index: row.index, account, keyHint: row.keyHint, payload: row.payload }
        }),
      }
    },
  })
}

// Events after which a session holds no more transport state.
const SESSION_END_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
])

/**
 * Session hooks carry no cancellation signal, so a session's pending lookups and
 * unsettled exchanges are cleaned up when the host reports its execution ended.
 */
function watchSessionEnds(ctx: Context, transport: V2Transport, signal: AbortSignal) {
  if (typeof ctx.event?.subscribe !== "function") return
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (!SESSION_END_EVENTS.has(event.type)) continue
        const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
        if (typeof sessionID === "string") transport.endSession(sessionID)
      }
    } catch (error) {
      if (!signal.aborted) log("warn", "session event stream failed", { error: error instanceof Error ? error.message : String(error) })
    }
  })()
}

export async function setupV2(ctx: Context) {
  const support = hostSupport(ctx)
  if (support === "v1-preview") {
    log("info", "V2 setup skipped", { reason: "OpenCode 1.x preview loader; the V1 server() entry handles rotation" })
    return
  }
  if (support !== "supported") {
    throw new Error(`oc-go-multi-auth supports OpenCode 1.18.29+ (V1) and ${SUPPORTED_RANGE} (V2), not ${support}.`)
  }

  const registrations: Registration[] = []
  let transport: ReturnType<typeof createV2Transport> | undefined
  let lease: ReturnType<typeof acquirePool>
  let active = true
  const lifetime = new AbortController()
  const cleanup = async () => {
    if (!active) return
    active = false
    lifetime.abort()
    transport?.dispose()
    lease?.release()
    await Promise.all(registrations.map((registration) => registration.dispose()))
  }

  try {
    const authorization = createAuthorization(ctx)
    registrations.push(await registerRpc(ctx, authorization))
    lease = acquirePool()
    if (!lease) {
      log("warn", "rotation setup skipped", { reason: "no enabled accounts", action: "restart after adding an account" })
      return cleanup
    }
    const { pool } = lease
    const hooks = createV2Transport(pool, { authorize: async (destination) => (await authorization(destination)) === undefined })
    transport = hooks
    const scope = { providerID: PROVIDER_ID }
    registrations.push(
      await ctx.session.hook("http.request", hooks["http.request"], scope),
      await ctx.session.hook("http.response", hooks["http.response"], scope),
      await ctx.session.hook("experimental.ws.handshake", hooks["experimental.ws.handshake"], scope),
      await ctx.session.hook("experimental.ws.receive", hooks["experimental.ws.receive"], scope),
      await ctx.session.hook("retry", hooks.retry, scope),
    )
    watchSessionEnds(ctx, hooks, lifetime.signal)
    const initial = pool.firstAvailable(pool.now()) ?? pool.probeCandidate()
    if (initial) {
      const activation = await activate(ctx, authorization, initial.account.apiKey)
      if (activation.status === "activated") log("info", "integration activated", { index: initial.index })
    }
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}
