import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import { GoAccountsRpc } from "../rpc"
import { accountId, accountsPath, loadAccounts, loadRotationState, saveAccounts, saveRotationState } from "../storage"
import type { GoAccount } from "../types"

const originalHome = process.env.HOME
let tmpHome: string
let plugin: typeof import("../index").default
let tuiPlugin: typeof import("../tui").default

function pluginInput(client: unknown = {}): Parameters<V1Plugin>[0] {
  return {
    client: client as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost"),
    experimental_workspace: {} as any,
    $: null as any,
  }
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit) {
  return new Headers(input instanceof Request ? input.headers : init?.headers)
}

function goAccount(apiKey: string, addedAt: number, label?: string, role: GoAccount["role"] = "primary"): GoAccount {
  return { apiKey, label, addedAt, enabled: true, role }
}

function installFailoverFetch() {
  const originalFetch = globalThis.fetch
  const authHeaders: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = requestHeaders(input, init).get("Authorization")!
    authHeaders.push(authorization)
    return authorization === "Bearer key-a"
      ? new Response("quota exceeded", { status: 429 })
      : new Response("ok", { status: 200 })
  }) as typeof fetch
  return { authHeaders, restore: () => { globalThis.fetch = originalFetch } }
}

function installUsageFetch() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    usage: {
      rolling: { status: "ok", percent: 12, resetsAt: "2026-09-15T08:00:00.000Z" },
      weekly: { status: "ok", percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
      monthly: { status: "ok", percent: 90, resetsAt: "2026-10-01T00:00:00.000Z" },
    },
  })) as typeof fetch
  return () => { globalThis.fetch = originalFetch }
}

async function until<T>(read: () => T | undefined, label = "condition"): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "go-plugin-test-"))
  process.env.HOME = tmpHome
  plugin = (await import("../index")).default
  tuiPlugin = (await import("../tui")).default
})

beforeEach(() => {
  saveAccounts({ version: 1, accounts: [], rotationIndex: 0 })
  saveRotationState({ lastUsedIndex: -1 })
})

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("OpenCode V1 adapter", () => {
  it("offers only the stock single-key method and never writes credentials from the loader", async () => {
    expect(plugin.id).toBe("oc-go-multi-auth")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10)], rotationIndex: 0 })
    let authWrites = 0
    const hooks = await plugin.server(pluginInput({ auth: { set: async () => { authWrites++ } } }))

    expect(hooks.auth!.provider).toBe("opencode-go")
    expect(hooks.auth!.methods).toEqual([{ type: "api", label: "Go API key" }])
    const options = await hooks.auth!.loader!(async () => ({ type: "api", key: "key-a" }), {} as any)
    expect(options.apiKey).toBe("")
    expect(typeof options.fetch).toBe("function")
    expect(authWrites).toBe(0)
  })

  it("returns no loader options without enabled accounts", async () => {
    const hooks = await plugin.server(pluginInput())
    expect(await hooks.auth!.loader!(async () => ({ type: "api", key: "host" }), {} as any)).toEqual({})
  })

  it("records failover in the rotation hint and never rewrites the account file", async () => {
    saveAccounts({
      version: 1,
      accounts: [goAccount("key-a", 10, "alpha"), goAccount("key-b", 20, "beta")],
      rotationIndex: 0,
    })
    const installedFetch = installFailoverFetch()

    try {
      const hooks = await plugin.server(pluginInput())
      const options = await hooks.auth!.loader!(async () => ({ type: "api", key: "key-a" }), {} as any)
      // A concurrent edit reorders and adds accounts after startup.
      const currentAccounts = [
        goAccount("key-b", 20, "beta-edited"),
        goAccount("key-c", 30, "gamma"),
        goAccount("key-a", 10, "alpha-edited"),
      ]
      saveAccounts({ version: 1, accounts: currentAccounts, rotationIndex: 2 })
      const before = readFileSync(accountsPath(), "utf-8")

      expect((await options.fetch!("https://api.example.com/first")).status).toBe(200)
      expect(loadRotationState()).toEqual({ lastUsedIndex: 0, lastUsedAccount: accountId(currentAccounts[0]) })
      expect(readFileSync(accountsPath(), "utf-8")).toBe(before)
      expect((await options.fetch!("https://api.example.com/second")).status).toBe(200)
      expect(installedFetch.authHeaders).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b"])
    } finally {
      installedFetch.restore()
    }
  })

  it("identifies the second duplicate credential by API key and addedAt", async () => {
    const sharedKey = "duplicate-test-key"
    const accounts = [goAccount(sharedKey, 10, "first"), goAccount(sharedKey, 20, "second")]
    saveAccounts({ version: 1, accounts, rotationIndex: 0 })
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      return new Response(callCount === 1 ? "quota exceeded" : "ok", { status: callCount === 1 ? 429 : 200 })
    }) as typeof fetch

    try {
      const hooks = await plugin.server(pluginInput())
      const options = await hooks.auth!.loader!(async () => ({ type: "api", key: sharedKey }), {} as any)
      expect((await options.fetch!("https://api.example.com")).status).toBe(200)
      expect(loadRotationState()).toEqual({ lastUsedIndex: 1, lastUsedAccount: accountId(accounts[1]) })
      expect(loadAccounts().rotationIndex).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("does not resurrect a failover winner removed from current account storage", async () => {
    saveAccounts({
      version: 1,
      accounts: [goAccount("key-a", 10, "alpha"), goAccount("key-b", 20, "beta")],
      rotationIndex: 0,
    })
    const installedFetch = installFailoverFetch()

    try {
      const hooks = await plugin.server(pluginInput())
      const options = await hooks.auth!.loader!(async () => ({ type: "api", key: "key-a" }), {} as any)
      saveAccounts({ version: 1, accounts: [goAccount("key-c", 30, "gamma"), goAccount("key-a", 10, "alpha")], rotationIndex: 0 })
      saveRotationState({ lastUsedIndex: 0 })

      expect((await options.fetch!("https://api.example.com")).status).toBe(200)
      expect(loadRotationState()).toEqual({ lastUsedIndex: 0 })
      expect(installedFetch.authHeaders).toEqual(["Bearer key-a", "Bearer key-b"])
    } finally {
      installedFetch.restore()
    }
  })

  it("resumes after the recorded account even when accounts were reordered, and honors a legacy index", async () => {
    const accounts = [goAccount("key-a", 10), goAccount("key-b", 20), goAccount("key-c", 30)]
    saveAccounts({ version: 1, accounts: [accounts[2], accounts[0], accounts[1]], rotationIndex: 0 })
    saveRotationState({ lastUsedIndex: 0, lastUsedAccount: accountId(accounts[0]) })
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(requestHeaders(input, init).get("Authorization")!)
      return new Response("ok")
    }) as typeof fetch

    try {
      const hooks = await plugin.server(pluginInput())
      const byIdentity = await hooks.auth!.loader!(async () => ({ type: "api", key: "host" }), {} as any)
      await byIdentity.fetch!("https://api.example.com")
      saveRotationState({ lastUsedIndex: 2 })
      const byLegacyIndex = await hooks.auth!.loader!(async () => ({ type: "api", key: "host" }), {} as any)
      await byLegacyIndex.fetch!("https://api.example.com")
      expect(seen).toEqual(["Bearer key-b", "Bearer key-c"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("does not register go-usage as a prompt command", async () => {
    const hooks = await plugin.server(pluginInput())
    const config: { command?: Record<string, { template: string; description?: string }> } = {}
    await hooks.config?.(config as any)
    expect(config.command?.["go-usage"]).toBeUndefined()
    expect(hooks["command.execute.before"]).toBeUndefined()
  })
})

function fakeV1Api(options: {
  connected?: string[]
  source?: "env" | "config" | "custom" | "api"
  authError?: unknown
} = {}) {
  type Dialog = { kind: string; props: any; onClose?: () => void }
  const dialogs: Dialog[] = []
  const toasts: Array<{ variant?: string; message: string; duration?: number }> = []
  const authSets: unknown[] = []
  const sizes: string[] = []
  let layer: any
  let sessionCalls = 0
  const component = (kind: string) => (props: unknown) => ({ kind, props })
  const api = {
    client: {
      session: { command() { sessionCalls++ }, prompt() { sessionCalls++ } },
      provider: {
        list: async () => ({
          data: {
            all: (options.connected ?? []).map((id) => ({ id, source: options.source ?? "api" })),
            default: {},
            connected: options.connected ?? [],
          },
          error: undefined,
        }),
      },
      auth: {
        set: async (input: unknown) => {
          authSets.push(input)
          return options.authError === undefined ? { data: true, error: undefined } : { data: undefined, error: options.authError }
        },
      },
    },
    keymap: { registerLayer(value: unknown) { layer = value; return () => {} } },
    ui: {
      toast(input: any) { toasts.push(input) },
      DialogSelect: component("select"),
      DialogAlert: component("alert"),
      DialogPrompt: component("prompt"),
      DialogConfirm: component("confirm"),
      dialog: {
        replace(render: () => { kind: string; props: unknown }, onClose?: () => void) {
          dialogs.push({ ...render(), onClose })
        },
        setSize(size: string) { sizes.push(size) },
        clear() {},
      },
    },
  }
  const command = (name: string) => layer.commands.find((candidate: { name: string }) => candidate.name === name)
  const next = (count: number, kind: string) => until(
    () => dialogs.length >= count && dialogs[count - 1].kind === kind ? dialogs[count - 1].props : undefined,
    `${kind} dialog #${count}`,
  )
  return { api, dialogs, toasts, authSets, sizes, command, next, get sessionCalls() { return sessionCalls } }
}

describe("OpenCode V1 TUI adapter", () => {
  it("registers /go-usage and /go-accounts as direct TUI commands", async () => {
    const host = fakeV1Api()
    await tuiPlugin.tui(host.api as any, undefined, {} as any)
    expect(tuiPlugin.id).toBe("oc-go-multi-auth")
    expect("server" in tuiPlugin).toBe(false)
    expect(host.command("go-usage")).toMatchObject({ slashName: "go-usage", namespace: "palette" })
    expect(host.command("go-accounts")).toMatchObject({ slashName: "go-accounts", namespace: "palette" })
  })

  it("lists usage, opens details, returns to the same list, and never shows a full key", async () => {
    saveAccounts({
      version: 1,
      accounts: [goAccount("secret-key-aaaa", 10, "First"), goAccount("secret-key-bbbb", 20, "Second")],
      rotationIndex: 0,
    })
    const restore = installUsageFetch()
    const host = fakeV1Api()
    try {
      await tuiPlugin.tui(host.api as any, undefined, {} as any)
      host.command("go-usage").run()
      const select = await host.next(1, "select")
      expect(host.toasts[0]).toEqual({ variant: "info", message: "Loading OpenCode Go usage...", duration: 2_000 })
      expect(host.sizes).toEqual(["xlarge"])
      expect(select.title).toContain("Esc close")
      expect(select.options.map((option: { value: string }) => option.value)).toEqual(["aggregate", "0", "1"])
      expect(select.options[0].title).toBe("Aggregate  5-hour 176% left \u00b7 weekly 120% left \u00b7 monthly 20% left")
      expect(select.options[1].title).toContain("1. First  [primary]  key ...aaaa  remaining")
      expect(JSON.stringify(select.options)).not.toContain("secret-key-")

      select.onSelect(select.options[2])
      const alert = await host.next(2, "alert")
      expect(alert.title).toContain("2. Second")
      expect(alert.title).toContain("Enter back")
      expect(alert.message).toMatch(/^5-hour/)
      expect(alert.message).not.toContain("secret-key-")

      alert.onConfirm()
      const reopened = await host.next(3, "select")
      expect(reopened.options).toEqual(select.options.map((option: object) => ({ ...option })))
      host.dialogs[2].onClose!()
      expect(host.sessionCalls).toBe(0)
    } finally {
      restore()
    }
  })

  it("shows the empty message directly without a selectable list", async () => {
    const host = fakeV1Api()
    await tuiPlugin.tui(host.api as any, undefined, {} as any)
    host.command("go-usage").run()
    const alert = await host.next(1, "alert")
    expect(alert.message).toBe("No Go accounts configured.")
  })

  it("logs and shows an error toast when the usage flow fails", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("secret-key-aaaa", 10)], rotationIndex: 0 })
    const restore = installUsageFetch()
    const host = fakeV1Api()
    host.api.ui.dialog.replace = () => { throw new Error("dialog unavailable") }
    try {
      await tuiPlugin.tui(host.api as any, undefined, {} as any)
      host.command("go-usage").run()
      await until(() => host.toasts.find((toast) => toast.variant === "error"), "error toast")
    } finally {
      restore()
    }
    const log = readFileSync(join(tmpHome, ".config", "opencode", "oc-go-multi-auth.log"), "utf-8")
    expect(log).toContain('"msg":"usage report failed"')
    expect(log).toContain('"error":"dialog unavailable"')
    expect(host.toasts.at(-1)).toEqual({ variant: "error", message: "Failed to load OpenCode Go usage." })
  })

  it("adds an account with a selected role and connects OpenCode Go only when it is not connected", async () => {
    const host = fakeV1Api()
    await tuiPlugin.tui(host.api as any, undefined, {} as any)
    host.command("go-accounts").run()
    const list = await host.next(1, "select")
    expect(list.options.map((option: { title: string }) => option.title)).toEqual(["Add account"])
    list.onSelect(list.options[0])
    ;(await host.next(2, "prompt")).onConfirm("  go-new-key-1234  ")
    ;(await host.next(3, "prompt")).onConfirm("Work")
    const role = await host.next(4, "select")
    expect(role.options.map((option: { value: string }) => option.value)).toEqual(["primary", "overage_fallback"])
    role.onSelect(role.options[1])
    const refreshed = await host.next(5, "select")

    expect(loadAccounts().accounts).toMatchObject([{ apiKey: "go-new-key-1234", label: "Work", role: "overage_fallback", enabled: true }])
    expect(host.authSets).toEqual([{ providerID: "opencode-go", auth: { type: "api", key: "go-new-key-1234" } }])
    const toast = host.toasts.at(-1)!
    expect(toast.variant).toBe("success")
    expect(toast.message).toContain("Saved Work [overage_fallback]")
    expect(toast.message).toContain("Restart OpenCode")
    expect(toast.message).not.toContain("go-new-key-1234")
    expect(refreshed.options[1].title).toBe("1. Work  [overage_fallback]  key ...1234")
  })

  it("keeps an existing OpenCode Go connection and reports activation failures separately from the save", async () => {
    const connected = fakeV1Api({ connected: ["opencode-go"] })
    await tuiPlugin.tui(connected.api as any, undefined, {} as any)
    connected.command("go-accounts").run()
    ;(await connected.next(1, "select")).onSelect({ value: { type: "add" } })
    ;(await connected.next(2, "prompt")).onConfirm("go-key-aaaa1111")
    ;(await connected.next(3, "prompt")).onConfirm("")
    ;(await connected.next(4, "select")).onSelect({ value: "primary" })
    await connected.next(5, "select")
    expect(connected.authSets).toEqual([])

    const failing = fakeV1Api({ authError: { message: "store rejected go-key-bbbb2222" } })
    await tuiPlugin.tui(failing.api as any, undefined, {} as any)
    failing.command("go-accounts").run()
    ;(await failing.next(1, "select")).onSelect({ value: { type: "add" } })
    ;(await failing.next(2, "prompt")).onConfirm("go-key-bbbb2222")
    ;(await failing.next(3, "prompt")).onConfirm("")
    ;(await failing.next(4, "select")).onSelect({ value: "primary" })
    await failing.next(5, "select")
    const toast = failing.toasts.at(-1)!
    expect(toast.variant).toBe("warning")
    expect(toast.message).toContain("connecting OpenCode Go failed")
    expect(toast.message).toContain("[redacted]")
    expect(toast.message).not.toContain("go-key-bbbb2222")
    expect(loadAccounts().accounts.map((account) => account.apiKey)).toEqual(["go-key-aaaa1111", "go-key-bbbb2222"])
  })

  async function addThroughDialogs(host: ReturnType<typeof fakeV1Api>, key: string, afterRole?: (count: number) => Promise<void>) {
    await tuiPlugin.tui(host.api as any, undefined, {} as any)
    host.command("go-accounts").run()
    ;(await host.next(1, "select")).onSelect({ value: { type: "add" } })
    ;(await host.next(2, "prompt")).onConfirm(key)
    ;(await host.next(3, "prompt")).onConfirm("")
    ;(await host.next(4, "select")).onSelect({ value: "primary" })
    await afterRole?.(5)
  }

  for (const source of ["env", "config", "custom"] as const) {
    it(`asks before replacing a ${source} connection, and stores the key only when the user connects`, async () => {
      const connect = fakeV1Api({ connected: ["opencode-go"], source })
      await addThroughDialogs(connect, "go-cfg-key-1111", async (count) => {
        const choice = await connect.next(count, "select")
        expect(choice.title).toBe("OpenCode Go is already connected")
        expect(choice.options.map((option: { title: string }) => option.title)).toEqual(["Connect pool account", "Keep current connection"])
        expect(choice.options[1].description).toBe("Leaves the connection unchanged; rotation needs a stored key and a restart")
        choice.onSelect(choice.options[0])
      })
      await connect.next(6, "select")
      expect(connect.authSets).toEqual([{ providerID: "opencode-go", auth: { type: "api", key: "go-cfg-key-1111" } }])
      expect(connect.toasts.at(-1)!.variant).toBe("success")

      const keep = fakeV1Api({ connected: ["opencode-go"], source })
      await addThroughDialogs(keep, "go-cfg-key-2222", async (count) => {
        const choice = await keep.next(count, "select")
        choice.onSelect(choice.options[1])
      })
      await keep.next(6, "select")
      expect(keep.authSets).toEqual([])
      expect(keep.toasts.at(-1)!.variant).toBe("warning")
      const note = keep.toasts.at(-1)!.message
      expect(note).toContain("connection was left unchanged")
      expect(note).toContain("rotation needs a key stored in OpenCode")
      expect(note).not.toContain("inactive")
      expect(loadAccounts().accounts.map((account) => account.apiKey)).toEqual(["go-cfg-key-1111", "go-cfg-key-2222"])
    })
  }

  it("changes roles and removes by stable identity, rejecting a stale selection", async () => {
    saveAccounts({
      version: 1,
      accounts: [goAccount("key-aaaa0001", 10, "Alpha"), goAccount("key-bbbb0002", 20, "Beta")],
      rotationIndex: 0,
    })
    const host = fakeV1Api()
    await tuiPlugin.tui(host.api as any, undefined, {} as any)
    host.command("go-accounts").run()
    const list = await host.next(1, "select")
    list.onSelect(list.options[2])
    const actions = await host.next(2, "select")
    expect(actions.options.map((option: { title: string }) => option.title)).toEqual([
      "Change role to overage_fallback",
      "Remove from the pool",
    ])
    // Another process removes Alpha, shifting Beta to position 1.
    saveAccounts({ version: 1, accounts: [goAccount("key-bbbb0002", 20, "Beta")], rotationIndex: 0 })
    actions.onSelect(actions.options[0])
    const afterRole = await host.next(3, "select")
    expect(loadAccounts().accounts[0].role).toBe("overage_fallback")

    afterRole.onSelect({ value: { type: "account", account: list.options[1].value.account } })
    ;(await host.next(4, "select")).onSelect({ value: "remove" })
    ;(await host.next(5, "confirm")).onConfirm()
    await host.next(6, "select")
    expect(host.toasts.at(-1)).toEqual({
      variant: "error",
      message: "That account no longer exists. Reopen the account list and try again.",
    })
    expect(loadAccounts().accounts.map((account) => account.label)).toEqual(["Beta"])
  })
})

function fakeV2Context(options: {
  version?: string
  connected?: boolean
  connectError?: Error
  integrationID?: string
  /** The provider's configured base URL; null leaves it unset. */
  baseURL?: string | null
  models?: unknown[]
  /** Leaves out ctx.model.list, as an older host would. */
  noModelList?: boolean
} = {}) {
  const hooks: Array<{ name: string; callback: Function; options?: { providerID?: string } }> = []
  const connects: Array<{ integrationID: string; key: string }> = []
  const disposed: string[] = []
  let rpc: { definition: unknown; handlers: Record<string, (input: unknown, context: any) => Promise<unknown>> } | undefined
  const registration = (name: string) => ({ dispose: async () => { disposed.push(name) } })
  const owner = {
    integrationID: options.integrationID,
    baseURL: options.baseURL === undefined ? "https://opencode.ai/zen/go/v1" : options.baseURL,
    models: options.models ?? [],
    onRead: undefined as (() => void) | undefined,
  }
  const pending: unknown[] = []
  let wake: (() => void) | undefined
  const subscriptions: AbortSignal[] = []
  const context = {
    app: { version: options.version ?? "2.0.28", channel: "latest" },
    provider: {
      get: async () => {
        const data = {
          id: "opencode-go",
          ...(owner.integrationID ? { integrationID: owner.integrationID } : {}),
          ...(owner.baseURL === null ? {} : { settings: { baseURL: owner.baseURL } }),
        }
        owner.onRead?.()
        return { location: {}, data }
      },
    },
    ...(options.noModelList ? {} : { model: { list: async () => ({ location: {}, data: owner.models }) } }),
    event: {
      subscribe: (requestOptions?: { signal?: AbortSignal }) => {
        if (requestOptions?.signal) subscriptions.push(requestOptions.signal)
        return (async function* () {
          while (!requestOptions?.signal?.aborted) {
            if (pending.length > 0) {
              yield pending.shift()
              continue
            }
            await new Promise<void>((resolve) => {
              wake = resolve
              requestOptions?.signal?.addEventListener("abort", () => resolve(), { once: true })
            })
          }
        })()
      },
    },
    session: {
      hook: async (name: string, callback: Function, hookOptions?: { providerID?: string }) => {
        hooks.push({ name, callback, options: hookOptions })
        return registration(name)
      },
    },
    rpc: {
      register: async (definition: unknown, handlers: any) => {
        rpc = { definition, handlers }
        return { ...registration("rpc"), events: { emit: async () => {} } }
      },
    },
    integration: {
      connection: { active: async () => options.connected ? { type: "credential", id: "existing" } : undefined },
      connect: {
        key: async (input: { integrationID: string; key: string }) => {
          if (options.connectError) throw options.connectError
          connects.push(input)
        },
      },
    },
  }
  const call = async (method: string, input: unknown, signal: AbortSignal = new AbortController().signal) => rpc!.handlers[method](input, {
    signal,
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  })
  const emit = (event: unknown) => {
    pending.push(event)
    wake?.()
  }
  return { context, hooks, connects, disposed, call, emit, owner, subscriptions, pendingEvents: () => pending.length, get rpc() { return rpc } }
}

describe("OpenCode V2 server adapter", () => {
  const cleanups: Array<() => Promise<void>> = []
  const setupV2 = async (context: unknown) => {
    const cleanup = await plugin.setup(context as never) as (() => Promise<void>) | undefined
    if (cleanup) cleanups.push(cleanup)
    return cleanup
  }
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  it("registers the RPC and provider-scoped transport hooks, and connects the first eligible key when unconnected", async () => {
    saveAccounts({
      version: 1,
      accounts: [goAccount("key-over", 5, "over", "overage_fallback"), goAccount("key-primary", 10, "main")],
      rotationIndex: 0,
    })
    const host = fakeV2Context()
    const cleanup = (await setupV2(host.context))!

    expect(host.rpc?.definition).toBe(GoAccountsRpc)
    expect(host.hooks.map((hook) => hook.name)).toEqual([
      "http.request",
      "http.response",
      "experimental.ws.handshake",
      "experimental.ws.receive",
      "retry",
    ])
    expect(host.hooks.every((hook) => hook.options?.providerID === "opencode-go")).toBe(true)
    expect(host.connects).toEqual([{ integrationID: "opencode-go", key: "key-primary" }])

    await cleanup()
    await cleanup()
    cleanups.length = 0
    expect(host.disposed.sort()).toEqual([
      "experimental.ws.handshake",
      "experimental.ws.receive",
      "http.request",
      "http.response",
      "retry",
      "rpc",
    ])
  })

  it("keeps an existing connection and survives a failed activation", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10)], rotationIndex: 0 })
    const connected = fakeV2Context({ connected: true })
    await setupV2(connected.context)
    expect(connected.connects).toEqual([])

    const failing = fakeV2Context({ connectError: new Error("store refused key-a") })
    await expect(setupV2(failing.context)).resolves.toBeFunction()
    expect(failing.hooks).toHaveLength(5)
    const log = readFileSync(join(tmpHome, ".config", "opencode", "oc-go-multi-auth.log"), "utf-8")
    expect(log).toContain("store refused [redacted]")
  })

  it("registers only the RPC when no accounts exist", async () => {
    const host = fakeV2Context()
    await setupV2(host.context)
    expect(host.rpc).toBeDefined()
    expect(host.hooks).toEqual([])
    expect(host.connects).toEqual([])
  })

  it("defers to server() under the OpenCode 1 preview loader and rejects unsupported V2 hosts", async () => {
    await expect(plugin.setup({ catalog: {}, integration: {}, options: {} } as never)).resolves.toBeUndefined()
    await expect(plugin.setup(fakeV2Context({ version: "2.0.2" }).context as never)).rejects.toThrow(">=2.0.28 <3")
    await expect(plugin.setup({ app: { version: "2.1.0" }, integration: {} } as never)).rejects.toThrow("without session hooks")
    await expect(setupV2(fakeV2Context({ version: "0.0.0-dev-202610130450" }).context)).resolves.toBeFunction()
  })

  it("serves display-safe account summaries and edits through the RPC", async () => {
    const host = fakeV2Context({ connected: true })
    await setupV2(host.context)

    const added = await host.call("add", { apiKey: " go-rpc-key-9876 ", label: "Remote", role: "overage_fallback" }) as any
    expect(added.activation).toEqual({ status: "already_connected" })
    expect(added.account).toMatchObject({ number: 1, label: "Remote", role: "overage_fallback", keyHint: "...9876" })
    const listed = await host.call("list", {}) as { accounts: Array<{ id: string }> }
    expect(JSON.stringify(listed)).not.toContain("go-rpc-key-9876")
    const id = listed.accounts[0].id

    expect(await host.call("setRole", { id, role: "primary" })).toMatchObject({ account: { role: "primary" } })
    expect(await host.call("setRole", { id, role: "paid" })).toEqual({
      type: "rejected",
      message: 'role must be "primary" or "overage_fallback"',
      data: {},
    })
    expect(await host.call("add", { apiKey: "   " })).toMatchObject({ type: "rejected", message: "An API key is required." })
    expect(await host.call("remove", { id })).toMatchObject({ account: { label: "Remote" } })
    expect(await host.call("remove", { id })).toMatchObject({ type: "rejected" })
    expect(loadAccounts().accounts).toEqual([])
  })

  it("activates the new key when OpenCode Go has no connection", async () => {
    const host = fakeV2Context()
    await setupV2(host.context)
    const added = await host.call("add", { apiKey: "go-first-key-0001" }) as any
    expect(added.activation).toEqual({ status: "activated" })
    expect(host.connects).toEqual([{ integrationID: "opencode-go", key: "go-first-key-0001" }])
  })

  it("shares one account pool across plugin instances until the last one cleans up", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10), goAccount("key-b", 20)], rotationIndex: 0 })
    const first = fakeV2Context({ connected: true })
    const second = fakeV2Context({ connected: true })
    const cleanupFirst = (await setupV2(first.context))!
    await setupV2(second.context)
    // Startup selection ran once, so both instances start on the same account.
    expect(loadRotationState().lastUsedAccount).toBe(accountId(goAccount("key-a", 10)))

    const invalid = () => new Response("{}", { status: 401 })
    const event = { sessionID: "s", agent: "a", model: { providerID: "opencode-go", id: "m" }, kind: "primary" }
    const request = new Request("https://opencode.ai/zen/go/v1/chat/completions", { headers: { authorization: "Bearer host" } })
    const hook = (host: typeof first, name: string) => host.hooks.find((candidate) => candidate.name === name)!.callback
    await hook(first, "http.request")({ ...event, request })
    await hook(first, "http.response")({ ...event, request, response: invalid() })
    await cleanupFirst()

    const next = new Request("https://opencode.ai/zen/go/v1/chat/completions", { headers: { authorization: "Bearer host" } })
    await hook(second, "http.request")({ ...event, request: next })
    expect(next.headers.get("authorization")).toBe("Bearer key-b")
  })

  const sessionEvent = { sessionID: "ses_1", agent: "build", model: { providerID: "opencode-go", id: "glm" }, kind: "primary" }
  const hookOf = (host: ReturnType<typeof fakeV2Context>, name: string) => host.hooks.find((candidate) => candidate.name === name)!.callback
  const goRequest = () => new Request("https://opencode.ai/zen/go/v1/chat/completions", { headers: { authorization: "Bearer host" } })

  it("keeps the pool away from a provider bound to another integration and says so", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10), goAccount("key-b", 20)], rotationIndex: 0 })
    const host = fakeV2Context({ integrationID: "opencode" })
    await setupV2(host.context)
    expect(host.hooks).toHaveLength(5)
    expect(host.connects).toEqual([])

    const gateway = goRequest()
    await hookOf(host, "http.request")({ ...sessionEvent, request: gateway })
    expect(gateway.headers.get("authorization")).toBe("Bearer host")
    const handshake = { ...sessionEvent, url: "wss://gateway.example/v1/responses", headers: { Authorization: "Bearer host" } }
    await hookOf(host, "experimental.ws.handshake")(handshake)
    expect(handshake.headers).toEqual({ Authorization: "Bearer host" })

    const added = await host.call("add", { apiKey: "go-console-key-4321" }) as any
    expect(added.activation.status).toBe("unsupported")
    expect(added.activation.message).toContain('"opencode" integration')
    expect(host.connects).toEqual([])
    expect(JSON.stringify(added)).not.toContain("go-console-key-4321")
    const log = readFileSync(join(tmpHome, ".config", "opencode", "oc-go-multi-auth.log"), "utf-8")
    expect(log).toContain('"msg":"rotation inactive"')

    // A reload that binds the provider back to the Go integration turns rotation on without a restart.
    host.owner.integrationID = "opencode-go"
    const own = goRequest()
    await hookOf(host, "http.request")({ ...sessionEvent, request: own })
    expect(own.headers.get("authorization")).toBe("Bearer key-a")
  })

  describe("destination guard", () => {
    const pool = () => saveAccounts({ version: 1, accounts: [goAccount("key-a", 10), goAccount("key-b", 20)], rotationIndex: 0 })
    const sent = async (host: ReturnType<typeof fakeV2Context>, url: string, event: Record<string, unknown> = sessionEvent) => {
      const request = new Request(url, { headers: { authorization: "Bearer host" } })
      await hookOf(host, "http.request")({ ...event, request })
      return request.headers.get("authorization")
    }
    const socket = async (host: ReturnType<typeof fakeV2Context>, url: string, event: Record<string, unknown> = sessionEvent) => {
      const handshake = { ...event, url, headers: { Authorization: "Bearer host" } }
      await hookOf(host, "experimental.ws.handshake")(handshake)
      return handshake.headers.Authorization
    }
    const logText = () => readFileSync(join(tmpHome, ".config", "opencode", "oc-go-multi-auth.log"), "utf-8")

    it("keeps a key off a request prepared for another gateway even after the provider is Go-owned again", async () => {
      pool()
      const host = fakeV2Context({ connected: true })
      await setupV2(host.context)
      // The request was built while a Console integration owned the provider; the provider is Go's by the time the hook runs.
      expect(await sent(host, "https://gateway.example/v1/chat/completions")).toBe("Bearer host")
      expect(await socket(host, "wss://gateway.example/v1/responses")).toBe("Bearer host")
      expect(logText()).toContain("https://gateway.example")
      expect(logText()).not.toContain("chat/completions")
      expect(await sent(host, "https://opencode.ai/zen/go/v1/chat/completions")).toBe("Bearer key-a")
    })

    it("compares exact origin and path segments, ignoring query and fragment", async () => {
      pool()
      const host = fakeV2Context({ connected: true })
      await setupV2(host.context)
      for (const url of [
        "https://opencode.ai/zen/go/chat/completions",
        "https://opencode.ai/zen/go/v1evil/chat/completions",
        "https://opencode.ai/zen/go/v1/../other",
        "https://opencode.ai.evil.example/zen/go/v1/chat/completions",
        "https://opencode.ai@evil.example/zen/go/v1/chat/completions",
        "https://opencode.ai:8443/zen/go/v1/chat/completions",
        "http://opencode.ai/zen/go/v1/chat/completions",
        "https://evil.example/path?https://opencode.ai/zen/go/v1/chat/completions#/zen/go/v1",
      ]) expect(await sent(host, url)).toBe("Bearer host")
      expect(await sent(host, "https://opencode.ai/zen/go/v1/chat/completions?next=https://evil.example#frag")).toBe("Bearer key-a")
      expect(await sent(host, "https://opencode.ai/zen/go/v1")).toBe("Bearer key-a")
      expect(await sent(host, "https://OPENCODE.AI:443/zen/go/v1/messages")).toBe("Bearer key-a")
    })

    it("accepts wss for an https base and refuses a ws downgrade or another port", async () => {
      pool()
      const host = fakeV2Context({ connected: true })
      await setupV2(host.context)
      expect(await socket(host, "wss://opencode.ai/zen/go/v1/responses")).toBe("Bearer key-a")
      expect(await socket(host, "ws://opencode.ai/zen/go/v1/responses")).toBe("Bearer host")
      expect(await socket(host, "wss://opencode.ai:8443/zen/go/v1/responses")).toBe("Bearer host")
      expect(await socket(host, "wss://opencode.ai/zen/gone/v1/responses")).toBe("Bearer host")

      const local = fakeV2Context({ connected: true, baseURL: "http://127.0.0.1:8080/go" })
      await setupV2(local.context)
      expect(await socket(local, "ws://127.0.0.1:8080/go/responses")).toBe("Bearer key-a")
      expect(await socket(local, "wss://127.0.0.1:8080/go/responses")).toBe("Bearer host")
    })

    it("follows a custom provider base URL and a model's or variant's own base URL", async () => {
      pool()
      const models = [
        { providerID: "opencode-go", id: "glm", modelID: "glm", settings: { baseURL: "https://model.example/v1" }, variants: [{ id: "fast", settings: { baseURL: "https://variant.example/v1/" } }] },
        { providerID: "other", id: "glm", modelID: "glm", settings: { baseURL: "https://wrong.example/v1" }, variants: [] },
      ]
      const host = fakeV2Context({ connected: true, baseURL: "https://proxy.example/go", models })
      await setupV2(host.context)
      expect(await sent(host, "https://proxy.example/go/chat/completions")).toBe("Bearer key-a")
      expect(await sent(host, "https://opencode.ai/zen/go/v1/chat/completions")).toBe("Bearer host")
      expect(await sent(host, "https://model.example/v1/messages")).toBe("Bearer key-a")
      expect(await sent(host, "https://wrong.example/v1/messages")).toBe("Bearer host")
      // A variant's base URL counts only for the selected variant.
      expect(await sent(host, "https://variant.example/v1/chat/completions")).toBe("Bearer host")
      const fast = { ...sessionEvent, model: { providerID: "opencode-go", id: "glm", variant: "fast" } }
      expect(await sent(host, "https://variant.example/v1/chat/completions", fast)).toBe("Bearer key-a")
      expect(await socket(host, "wss://variant.example/v1/responses", fast)).toBe("Bearer key-a")
      // A model that is not in the list falls back to the provider's base URL alone.
      const unknown = { ...sessionEvent, model: { providerID: "opencode-go", id: "unlisted" } }
      expect(await sent(host, "https://model.example/v1/messages", unknown)).toBe("Bearer host")
    })

    it("takes a model's base URLs from its own listing, never from an alias that names it as upstream", async () => {
      pool()
      const exact = { providerID: "opencode-go", id: "glm", modelID: "glm", settings: { baseURL: "https://model.example/v1" }, variants: [{ id: "fast", settings: { baseURL: "https://variant.example/v1" } }] }
      const alias = { providerID: "opencode-go", id: "alias", modelID: "glm", settings: { baseURL: "https://alias.example/v1" }, variants: [{ id: "fast", settings: { baseURL: "https://aliasvariant.example/v1" } }] }
      const fast = { ...sessionEvent, model: { providerID: "opencode-go", id: "glm", variant: "fast" } }
      for (const models of [[alias, exact], [exact, alias]]) {
        const host = fakeV2Context({ connected: true, baseURL: "https://proxy.example/go", models })
        await setupV2(host.context)
        const selected = { ...sessionEvent, model: { providerID: "opencode-go", id: "glm" } }
        expect(await sent(host, "https://model.example/v1/messages", selected)).toBe("Bearer key-a")
        expect(await sent(host, "https://alias.example/v1/messages", selected)).toBe("Bearer host")
        expect(await sent(host, "https://variant.example/v1/chat/completions", fast)).toBe("Bearer key-a")
        expect(await socket(host, "wss://variant.example/v1/responses", fast)).toBe("Bearer key-a")
        expect(await sent(host, "https://aliasvariant.example/v1/chat/completions", fast)).toBe("Bearer host")
        expect(await socket(host, "wss://aliasvariant.example/v1/responses", fast)).toBe("Bearer host")
        expect(await socket(host, "wss://alias.example/v1/responses", selected)).toBe("Bearer host")
      }
    })

    it("stays out of routing it cannot match, and names only an origin", async () => {
      pool()
      const unresolved = fakeV2Context({ connected: true, baseURL: "https://${GATEWAY_HOST}/v1?token=sekrit-value" })
      await setupV2(unresolved.context)
      expect(await sent(unresolved, "https://opencode.ai/zen/go/v1/chat/completions")).toBe("Bearer host")
      expect(logText()).toContain("unresolved")
      expect(logText()).not.toContain("sekrit-value")

      const none = fakeV2Context({ connected: true, baseURL: null, noModelList: true })
      await setupV2(none.context)
      expect(await sent(none, "https://opencode.ai/zen/go/v1/chat/completions")).toBe("Bearer host")
      expect(logText()).toContain("no base URL configured")
    })

    it("refuses an attempt whose configuration changed while the destination was checked", async () => {
      pool()
      const host = fakeV2Context({ connected: true, baseURL: "https://proxy.example/go", models: [] })
      await setupV2(host.context)
      let reads = 0
      host.owner.onRead = () => {
        // Runs after the first read (the provider check) built its data, so the re-read after the model list sees the change.
        if (++reads === 1) host.owner.baseURL = "https://opencode.ai/zen/go/v1"
      }
      expect(await sent(host, "https://opencode.ai/zen/go/v1/chat/completions")).toBe("Bearer host")
      expect(logText()).toContain("configuration changed")
    })

    it("still activates through the owner-only check when the request destination cannot be matched", async () => {
      const host = fakeV2Context({ baseURL: null, noModelList: true })
      await setupV2(host.context)
      const added = await host.call("add", { apiKey: "go-first-key-0001" }) as any
      expect(added.activation).toEqual({ status: "activated" })
    })
  })

  it("drops a session's unsettled exchange when the host reports its execution ended", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10), goAccount("key-b", 20)], rotationIndex: 0 })
    const host = fakeV2Context({ connected: true })
    await setupV2(host.context)
    const rateLimit = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } })
    const handshake = () => hookOf(host, "experimental.ws.handshake")({ ...sessionEvent, url: "wss://opencode.ai/zen/go/v1/responses", headers: { Authorization: "Bearer host" } })

    await handshake()
    host.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_other", reason: "user" } })
    host.emit({ type: "session.text.delta", data: { sessionID: "ses_1" } })
    host.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } })
    await until(() => host.pendingEvents() === 0 ? true : undefined, "event stream drained")
    hookOf(host, "experimental.ws.receive")({ ...sessionEvent, frame: rateLimit })
    const afterEnd = goRequest()
    await hookOf(host, "http.request")({ ...sessionEvent, request: afterEnd })
    expect(afterEnd.headers.get("authorization")).toBe("Bearer key-a")

    // Without the event the same frame cools key-a.
    await handshake()
    hookOf(host, "experimental.ws.receive")({ ...sessionEvent, frame: rateLimit })
    const afterFrame = goRequest()
    await hookOf(host, "http.request")({ ...sessionEvent, request: afterFrame })
    expect(afterFrame.headers.get("authorization")).toBe("Bearer key-b")
  })

  it("stops listening for session events on cleanup", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10)], rotationIndex: 0 })
    const host = fakeV2Context({ connected: true })
    const cleanup = (await setupV2(host.context))!
    expect(host.subscriptions).toHaveLength(1)
    expect(host.subscriptions[0].aborted).toBe(false)
    await cleanup()
    cleanups.length = 0
    expect(host.subscriptions[0].aborted).toBe(true)
  })

  it("stops a usage query when the RPC caller goes away", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("secret-usage-key-77aa", 10, "Work")], rotationIndex: 0 })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch
    const host = fakeV2Context({ connected: true })
    try {
      await setupV2(host.context)
      const caller = new AbortController()
      const pending = host.call("usage", {}, caller.signal) as Promise<{ rows: Array<Record<string, unknown>> }>
      caller.abort()
      const started = Date.now()
      expect((await pending).rows[0]).toMatchObject({ kind: "error", error: "timed out" })
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns usage rows without keys", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("secret-usage-key-77aa", 10, "Work")], rotationIndex: 0 })
    const restore = installUsageFetch()
    const host = fakeV2Context({ connected: true })
    try {
      await setupV2(host.context)
      const result = await host.call("usage", {}) as { rows: Array<Record<string, unknown>> }
      expect(result.rows[0]).toMatchObject({ kind: "ok", index: 0, account: { label: "Work", role: "primary" }, keyHint: "...77aa" })
      expect(Object.keys(result.rows[0]).sort()).toEqual(["account", "index", "keyHint", "kind", "payload"])
      expect(JSON.stringify(result)).not.toContain("secret-usage-key-77aa")
    } finally {
      restore()
    }
  })
})

describe("OpenCode V2 TUI adapter", () => {
  function fakeV2Tui(rpc: Record<string, (input: unknown, options?: unknown) => Promise<unknown>>) {
    let layer: any
    const toasts: unknown[] = []
    const sizes: string[] = []
    const selects: any[] = []
    const prompts: string[] = []
    const answers: unknown[] = []
    const calls: Array<{ method: string; input: unknown; options: unknown }> = []
    const context = {
      location: { directory: "/work" },
      client: {
        rpc: (definition: unknown) => {
          expect(definition).toBe(GoAccountsRpc)
          return Object.fromEntries(Object.entries(rpc).map(([method, handler]) => [method, (input: unknown, options: unknown) => {
            calls.push({ method, input, options })
            return handler(input, options)
          }]))
        },
      },
      keymap: { layer(factory: () => unknown) { layer = factory() } },
      ui: {
        toast: { show(input: unknown) { toasts.push(input) } },
        dialog: {
          set(input: { size: string }) { sizes.push(input.size) },
          select: async (input: unknown) => { selects.push(input); return answers.shift() },
          prompt: async (input: { title: string }) => { prompts.push(input.title); return answers.shift() },
          confirm: async () => answers.shift(),
          alert: async () => {},
        },
      },
    }
    tuiPlugin.setup(context as never)
    const command = (slash: string) => layer.commands.find((candidate: any) => candidate.slash.name === slash)
    return { command, toasts, sizes, selects, prompts, answers, calls, get layer() { return layer } }
  }

  it("registers palette and slash commands and drives account edits through the RPC", async () => {
    const summary = { id: "abc", number: 1, label: "Remote", role: "primary", enabled: true, keyHint: "...9876", lastUsed: true }
    const host = fakeV2Tui({
      list: async () => ({ accounts: [summary] }),
      add: async () => ({ account: { ...summary, label: "New" }, count: 2, activation: { status: "activated" } }),
      setRole: async () => { throw { type: "rejected", message: "That account no longer exists." } },
      remove: async () => ({ account: summary }),
      usage: async () => ({ rows: [] }),
    })
    // The host hides base-mode layers where the prompt runs, so the layer must opt out.
    expect(host.layer.mode).toBe("global")
    expect(host.command("go-accounts")).toMatchObject({ id: "oc-go-multi-auth.accounts", palette: true, group: "OpenCode Go" })
    expect(host.command("go-usage")).toMatchObject({ id: "oc-go-multi-auth.usage", palette: true })

    host.answers.push({ type: "add" }, "go-new-key", "New", "primary", { type: "account", account: summary }, "role", undefined)
    host.command("go-accounts").run()
    await until(() => host.answers.length === 0 && host.selects.length === 5 ? true : undefined, "account flow")

    expect(host.selects[0].options[1].title).toBe("1. Remote  [primary]  key ...9876  last used")
    expect(host.prompts).toEqual(["Go API key", "Label (optional)"])
    expect(host.calls.find((call) => call.method === "add")).toEqual({
      method: "add",
      input: { apiKey: "go-new-key", label: "New", role: "primary" },
      options: { location: { directory: "/work" } },
    })
    expect(host.toasts).toEqual([
      { variant: "success", message: "Saved New [primary]. OpenCode Go is now connected with this key. Restart OpenCode to use the updated account list." },
      { variant: "error", message: "That account no longer exists." },
    ])
  })

  it("shows usage from the RPC in a wide dialog", async () => {
    const host = fakeV2Tui({
      usage: async () => ({
        rows: [{
          kind: "ok",
          index: 0,
          account: { label: "Work", role: "primary" },
          keyHint: "...77aa",
          payload: {
            rolling: { status: "ok", percent: 12, resetsAt: "2026-09-15T08:00:00.000Z" },
            weekly: { status: "ok", percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
            monthly: { status: "ok", percent: 90, resetsAt: "2026-10-01T00:00:00.000Z" },
          },
        }],
      }),
    })
    host.answers.push(undefined)
    host.command("go-usage").run()
    await until(() => host.selects.length === 1 ? true : undefined, "usage list")
    expect(host.selects[0].options.map((option: { title: string }) => option.title)).toEqual([
      "Aggregate  5-hour 88% left \u00b7 weekly 60% left \u00b7 monthly 10% left",
      "1. Work  [primary]  key ...77aa  remaining",
    ])
    expect(host.sizes).toEqual(["xlarge"])
  })
})
