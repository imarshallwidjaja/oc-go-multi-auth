import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import { loadAccounts, loadRotationState, saveAccounts, saveRotationState } from "../storage"

const originalHome = process.env.HOME
let tmpHome: string
let plugin: typeof import("../index").default
let tuiPlugin: typeof import("../tui").default

function pluginInput(client: unknown): Parameters<V1Plugin>[0] {
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

function authSetSuccess() {
  return {
    data: true,
    error: undefined,
    request: new Request("http://localhost/auth/opencode-go"),
    response: new Response(null, { status: 200 }),
  }
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

function createV2Context({
  failPriming = false,
  alreadyConnected = false,
  providerPackage = "aisdk:@ai-sdk/openai-compatible",
  providerCanonical,
  providerSettings,
  providerHeaders,
  providerBody,
  models,
}: {
  failPriming?: boolean
  alreadyConnected?: boolean
  providerPackage?: string
  providerCanonical?: string
  providerSettings?: Record<string, unknown>
  providerHeaders?: Record<string, string>
  providerBody?: Record<string, unknown>
  models?: Array<{
    id: string
    providerID: string
    package?: string
    settings?: Record<string, unknown>
    headers?: Record<string, string>
    body?: Record<string, unknown>
  }>
} = {}) {
  type IntegrationMethod = { type: string; label?: string }
  type CatalogProvider = {
    id: string
    name: string
    package: string
    canonical?: string
    settings?: Record<string, unknown>
    headers?: Record<string, string>
    body?: Record<string, unknown>
  }
  type CatalogModel = {
    id: string
    providerID: string
    package?: string
    settings?: Record<string, unknown>
    headers?: Record<string, string>
    body?: Record<string, unknown>
  }

  const integrations = new Map<string, { id: string; name: string }>()
  const methods = new Map<string, IntegrationMethod[]>()
  const connections: Array<{ integrationID: string; key: string }> = []
  const order: string[] = []
  let connected = alreadyConnected
  let integrationRegistrations = 0
  const catalogTransforms: Array<(editor: any) => void> = []
  const commands: Array<{ name: string; description?: string; execute: (input: { sessionID: string }) => Promise<void> }> = []
  const synthetics: Array<{ sessionID: string; text: string }> = []
  let commandRegistrations = 0
  const baseProvider: CatalogProvider = {
    id: "opencode-go",
    name: "OpenCode Go",
    package: providerPackage,
    canonical: providerCanonical,
    settings: providerSettings,
    headers: providerHeaders,
    body: providerBody,
  }
  const baseModels: CatalogModel[] = models ?? [
    { id: "chat-model", providerID: "opencode-go" },
    { id: "messages-model", providerID: "opencode-go", package: "aisdk:@ai-sdk/anthropic" },
    { id: "responses-model", providerID: "opencode-go", package: "aisdk:@ai-sdk/openai" },
  ]
  let catalogProvider = structuredClone(baseProvider)
  let catalogModels = new Map(baseModels.map((model) => [model.id, structuredClone(model)]))

  const catalogEditor = () => ({
    provider: {
      list: () => [{ provider: catalogProvider, models: catalogModels }],
      get: (id: string) => id === catalogProvider.id ? { provider: catalogProvider, models: catalogModels } : undefined,
      update() {},
      remove() {},
    },
    model: {
      get: (providerID: string, modelID: string) => providerID === catalogProvider.id
        ? catalogModels.get(modelID)
        : undefined,
      update() {},
      remove() {},
      default: { get: () => undefined, set() {} },
    },
  })
  const rebuildCatalog = () => {
    catalogProvider = structuredClone(baseProvider)
    catalogModels = new Map(baseModels.map((model) => [model.id, structuredClone(model)]))
    for (const transform of catalogTransforms) transform(catalogEditor())
  }

  const context = {
    integration: {
      transform: async (transform: (editor: any) => void) => {
        order.push("integration.transform")
        integrationRegistrations++
        transform({
          list: () => [...integrations.values()],
          get: (id: string) => integrations.get(id),
          update(id: string, update: (integration: { id: string; name: string }) => void) {
            const integration = integrations.get(id) ?? { id, name: id }
            update(integration)
            integrations.set(id, integration)
          },
          remove: (id: string) => integrations.delete(id),
          method: {
            list: (integrationID: string) => methods.get(integrationID) ?? [],
            update(input: { integrationID: string; method: IntegrationMethod }) {
              const current = methods.get(input.integrationID) ?? []
              const index = current.findIndex((method) => method.type === input.method.type)
              if (index === -1) current.push(input.method)
              else current[index] = input.method
              methods.set(input.integrationID, current)
            },
            remove() {},
          },
        })
        let active = true
        return {
          dispose: async () => {
            if (!active) return
            active = false
            integrationRegistrations--
          },
        }
      },
      connect: {
        key: async (input: { integrationID: string; key: string }) => {
          order.push("integration.connect.key")
          const keyMethod = methods.get(input.integrationID)?.some((method) => method.type === "key")
          if (!keyMethod) throw new Error(`Key method not found: ${input.integrationID}`)
          if (failPriming) throw new Error("credential store unavailable")
          connections.push(input)
          connected = true
        },
      },
      connection: {
        active: async () => {
          order.push("integration.connection.active")
          return connected ? ({ type: "credential", id: "existing" }) : undefined
        },
      },
    },
    catalog: {
      transform: async (transform: (editor: any) => void) => {
        order.push("catalog.transform")
        catalogTransforms.push(transform)
        rebuildCatalog()
        let active = true
        return {
          dispose: async () => {
            if (!active) return
            active = false
            const index = catalogTransforms.indexOf(transform)
            if (index !== -1) catalogTransforms.splice(index, 1)
            rebuildCatalog()
          },
        }
      },
    },
    command: {
      transform: async (transform: (editor: any) => void) => {
        order.push("command.transform")
        commandRegistrations++
        const added: typeof commands = []
        transform({
          add(definition: { name: string; description?: string; execute: (input: { sessionID: string }) => Promise<void> }) {
            added.push(definition)
            commands.push(definition)
          },
        })
        let active = true
        return {
          dispose: async () => {
            if (!active) return
            active = false
            commandRegistrations--
            for (const definition of added) {
              const index = commands.indexOf(definition)
              if (index !== -1) commands.splice(index, 1)
            }
          },
        }
      },
    },
    session: {
      synthetic: async (input: { sessionID: string; text: string }) => {
        synthetics.push(input)
      },
    },
  } as any

  return {
    connections,
    context,
    get catalogProvider() { return catalogProvider },
    get catalogModels() { return catalogModels },
    get integrationRegistrations() { return integrationRegistrations },
    get catalogRegistrations() { return catalogTransforms.length },
    get commandRegistrations() { return commandRegistrations },
    commands,
    synthetics,
    integrations,
    methods,
    order,
  }
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
  it("exports the opencode-go auth hook and stores credentials under that provider", async () => {
    expect(plugin.id).toBe("oc-go-multi-auth")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: Date.now(), enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const calls: Array<{ path: { id: string } }> = []
    const client = {
      auth: {
        set: async (call: { path: { id: string } }) => {
          calls.push(call)
          return authSetSuccess()
        },
      },
    }
    const hooks = await plugin.server(pluginInput(client))

    expect(hooks.auth!.provider).toBe("opencode-go")
    expect(typeof hooks.auth!.loader).toBe("function")
    await hooks.auth!.loader(async () => ({ type: "api", key: "key-a" }))
    const method = hooks.auth!.methods.find((candidate) => candidate.label === "Add Go Account")!
    expect(method).toBeDefined()
    await method.authorize({ apiKey: "key-b", label: "beta" })

    expect(calls.map((call) => call.path.id)).toEqual(["opencode-go", "opencode-go"])
    expect(loadAccounts().accounts.map((a) => ({ key: a.apiKey, role: a.role }))).toEqual([
      { key: "key-a", role: "primary" },
      { key: "key-b", role: "primary" },
    ])
  })

  it("stores overage_fallback on add and updates role via Set Go Account Role", async () => {
    const client = { auth: { set: async () => authSetSuccess() } }
    const hooks = await plugin.server(pluginInput(client))
    const add = hooks.auth!.methods.find((candidate) => candidate.label === "Add Go Account")!
    const setRole = hooks.auth!.methods.find((candidate) => candidate.label === "Set Go Account Role")!

    await add.authorize({ apiKey: "key-a", label: "alpha", role: "primary" })
    await add.authorize({ apiKey: "key-b", label: "beta", role: "overage_fallback" })
    expect(loadAccounts().accounts.map((a) => a.role)).toEqual(["primary", "overage_fallback"])

    const result = await setRole.authorize({ account: "2", role: "primary" })
    expect(result).toEqual({ type: "success", key: "key-a" })
    expect(loadAccounts().accounts[1].role).toBe("primary")
  })

  it("fails explicitly when the V1 SDK returns an auth.set error result", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    let calls = 0
    const client = {
      auth: {
        set: async () => {
          calls++
          return {
            data: undefined,
            error: { name: "BadRequest", message: "store unavailable" },
            request: new Request("http://localhost/auth/opencode-go"),
            response: new Response(null, { status: 400 }),
          }
        },
      },
    }
    const hooks = await plugin.server(pluginInput(client))

    await expect(hooks.auth!.loader(async () => ({ type: "api", key: "key-a" }))).rejects.toThrow(
      "Failed to set OpenCode Go authentication: {\"name\":\"BadRequest\",\"message\":\"store unavailable\"}",
    )
    const add = hooks.auth!.methods.find((candidate) => candidate.label === "Add Go Account")!
    await expect(add.authorize({ apiKey: "key-b" })).rejects.toThrow("Failed to set OpenCode Go authentication")
    expect(calls).toBe(2)
  })

  it("maps failover persistence to reordered current accounts without overwriting additions", async () => {
    saveAccounts({
      version: 1,
      accounts: [
        { apiKey: "key-a", label: "alpha", addedAt: 10, enabled: true, role: "primary" },
        { apiKey: "key-b", label: "beta", addedAt: 20, enabled: true, role: "primary" },
      ],
      rotationIndex: 0,
    })
    const installedFetch = installFailoverFetch()

    try {
      const client = { auth: { set: async () => authSetSuccess() } }
      const hooks = await plugin.server(pluginInput(client))
      const options = await hooks.auth!.loader(async () => ({ type: "api", key: "key-a" }))
      const currentAccounts = [
        { apiKey: "key-b", label: "beta-edited", addedAt: 20, enabled: true, role: "primary" as const },
        { apiKey: "key-c", label: "gamma", addedAt: 30, enabled: true, role: "primary" as const },
        { apiKey: "key-a", label: "alpha-edited", addedAt: 10, enabled: true, role: "primary" as const },
      ]
      saveAccounts({ version: 1, accounts: currentAccounts, rotationIndex: 2 })

      expect((await options.fetch!("https://api.example.com/first")).status).toBe(200)
      expect(loadRotationState()).toEqual({ lastUsedIndex: 0 })
      expect(loadAccounts()).toEqual({ version: 1, accounts: currentAccounts, rotationIndex: 0 })
      expect((await options.fetch!("https://api.example.com/second")).status).toBe(200)
      expect(installedFetch.authHeaders).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b"])
    } finally {
      installedFetch.restore()
    }
  })

  it("persists the second duplicate credential by API key and addedAt", async () => {
    const sharedKey = "duplicate-test-key"
    saveAccounts({
      version: 1,
      accounts: [
        { apiKey: sharedKey, label: "first", addedAt: 10, enabled: true, role: "primary" },
        { apiKey: sharedKey, label: "second", addedAt: 20, enabled: true, role: "primary" },
      ],
      rotationIndex: 0,
    })
    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      return new Response(callCount === 1 ? "quota exceeded" : "ok", { status: callCount === 1 ? 429 : 200 })
    }) as typeof fetch

    try {
      const client = { auth: { set: async () => authSetSuccess() } }
      const hooks = await plugin.server(pluginInput(client))
      const options = await hooks.auth!.loader(async () => ({ type: "api", key: sharedKey }))

      expect((await options.fetch!("https://api.example.com")).status).toBe(200)
      expect(loadAccounts().rotationIndex).toBe(1)
      expect(loadRotationState().lastUsedIndex).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("does not resurrect a failover winner removed from current account storage", async () => {
    saveAccounts({
      version: 1,
      accounts: [
        { apiKey: "key-a", label: "alpha", addedAt: 10, enabled: true, role: "primary" },
        { apiKey: "key-b", label: "beta", addedAt: 20, enabled: true, role: "primary" },
      ],
      rotationIndex: 0,
    })
    const installedFetch = installFailoverFetch()

    try {
      const client = { auth: { set: async () => authSetSuccess() } }
      const hooks = await plugin.server(pluginInput(client))
      const options = await hooks.auth!.loader(async () => ({ type: "api", key: "key-a" }))
      const currentAccounts = [
        { apiKey: "key-c", label: "gamma", addedAt: 30, enabled: true, role: "primary" as const },
        { apiKey: "key-a", label: "alpha", addedAt: 10, enabled: true, role: "primary" as const },
      ]
      saveAccounts({ version: 1, accounts: currentAccounts, rotationIndex: 0 })
      saveRotationState({ lastUsedIndex: 0 })

      expect((await options.fetch!("https://api.example.com")).status).toBe(200)
      expect(loadAccounts()).toEqual({ version: 1, accounts: currentAccounts, rotationIndex: 0 })
      expect(loadRotationState()).toEqual({ lastUsedIndex: 0 })
      expect(installedFetch.authHeaders).toEqual(["Bearer key-a", "Bearer key-b"])
    } finally {
      installedFetch.restore()
    }
  })

  it("does not register go-usage as a prompt command", async () => {
    const client = { auth: { set: async () => authSetSuccess() } }
    const hooks = await plugin.server(pluginInput(client))
    const config: { command?: Record<string, { template: string; description?: string }> } = {}

    await hooks.config?.(config as any)

    expect(config.command?.["go-usage"]).toBeUndefined()
    expect(hooks["command.execute.before"]).toBeUndefined()
  })
})

describe("OpenCode V1 TUI adapter", () => {
  it("registers go-usage as a direct TUI command without invoking a session command", async () => {
    const apiKey = "secret-key-x1ab"
    saveAccounts({
      version: 1,
      accounts: [{ apiKey, label: "Work", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe("https://opencode.ai/zen/go/v1/usage")
      expect(request.headers.get("Authorization")).toBe(`Bearer ${apiKey}`)
      return Response.json({
        usage: {
          rolling: { status: "ok", percent: 12, resetsAt: "2026-09-15T08:00:00.000Z" },
          weekly: { status: "ok", percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
          monthly: { status: "ok", percent: 90, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      })
    }) as typeof fetch
    let layer: any
    let dialogRenders = 0
    let dialogSize = "medium"
    let select: unknown
    let alert: unknown
    const dialogCalls: string[] = []
    const toastCalls: unknown[] = []
    let sessionCalls = 0
    const api = {
      client: {
        session: {
          command() { sessionCalls++ },
          prompt() { sessionCalls++ },
        },
      },
      keymap: {
        registerLayer(value: unknown) {
          layer = value
          return () => {}
        },
      },
      ui: {
        toast(input: unknown) { toastCalls.push(input) },
        DialogAlert(input: unknown) {
          alert = input
          return input
        },
        DialogSelect(input: unknown) {
          select = input
          return input
        },
        dialog: {
          setSize(size: string) {
            dialogCalls.push("setSize")
            dialogSize = size
          },
          replace(render: () => unknown) {
            expect(render).toBeFunction()
            dialogCalls.push("replace")
            // OpenCode 1.18.30 resets the stack size during replace.
            dialogSize = "medium"
            dialogRenders++
            render()
          },
        },
      },
    }

    await tuiPlugin.tui(api as any, undefined, {} as any)

    expect(tuiPlugin.id).toBe("oc-go-multi-auth")
    expect("server" in tuiPlugin).toBe(false)
    expect(tuiPlugin.setup).toBeFunction()
    await expect(tuiPlugin.setup()).resolves.toBeUndefined()
    expect(layer.commands).toHaveLength(1)
    expect(layer.commands[0]).toMatchObject({
      name: "go-usage",
      slashName: "go-usage",
      namespace: "palette",
    })

    try {
      await layer.commands[0].run()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(toastCalls).toEqual([{
      variant: "info",
      message: "Loading OpenCode Go usage...",
      duration: 2_000,
    }])
    expect(dialogCalls).toEqual(["replace", "setSize"])
    expect(dialogSize).toBe("xlarge")
    expect(dialogRenders).toBe(1)
    const renderedSelect = select as {
      title: string
      placeholder: string
      options: Array<{ title: string; value: string }>
      onSelect(option: { title: string; value: string }): void
    }
    expect(renderedSelect.title).toContain("Up/Down, PgUp/PgDn, Home/End")
    expect(renderedSelect.title).toContain("Esc close")
    expect(renderedSelect.placeholder).toBe("Filter accounts")
    expect(renderedSelect.options).toHaveLength(2)
    expect(renderedSelect.options[0]).toEqual({
      title: "Aggregate  5-hour 88% left \u00b7 weekly 60% left \u00b7 monthly 10% left",
      value: "aggregate",
    })
    expect(renderedSelect.options[1]?.title).toContain("1. Work  [primary]  key ...x1ab  remaining")
    expect(renderedSelect.options[1]?.value).toBe("0")
    const initialOptions = renderedSelect.options.map((option) => ({ ...option }))

    renderedSelect.onSelect(renderedSelect.options[0]!)
    const aggregateAlert = alert as { title: string; message: string; onConfirm(): void }
    expect(aggregateAlert.message).toBe([
      "   5-hour   88% left",
      "   weekly   60% left",
      "   monthly  10% left",
    ].join("\n"))

    renderedSelect.onSelect(renderedSelect.options[1]!)
    const renderedAlert = alert as { title: string; message: string; onConfirm(): void }
    expect(renderedAlert.title).toContain("Enter back; Esc close")
    expect(renderedAlert.message).toContain("12% used")
    expect(renderedAlert.message).toMatch(/^5-hour/)
    expect(sessionCalls).toBe(0)

    renderedAlert.onConfirm()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dialogRenders).toBe(4)
    const reopenedSelect = select as typeof renderedSelect
    expect(reopenedSelect.options).toEqual(initialOptions)
  })

  it("gives accounts with identical details distinct selector identities", async () => {
    saveAccounts({
      version: 1,
      accounts: [
        { apiKey: "secret-key-aaaa", label: "First", addedAt: 10, enabled: true, role: "primary" },
        { apiKey: "secret-key-bbbb", label: "Second", addedAt: 20, enabled: true, role: "primary" },
      ],
      rotationIndex: 0,
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-09-15T08:00:00.000Z" },
        weekly: { status: "ok", percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 90, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    })) as typeof fetch
    let layer: any
    let select: any
    let alert: any

    await tuiPlugin.tui({
      keymap: { registerLayer(value: unknown) { layer = value; return () => {} } },
      ui: {
        toast() {},
        DialogSelect(input: unknown) { select = input; return input },
        DialogAlert(input: unknown) { alert = input; return input },
        dialog: { replace(render: () => unknown) { render() }, setSize() {} },
      },
    } as any, undefined, {} as any)

    try {
      await layer.commands[0].run()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(select.options).toHaveLength(3)
    expect(select.options[0].value).toBe("aggregate")
    expect(select.options[0].title).toBe("Aggregate  5-hour 176% left \u00b7 weekly 120% left \u00b7 monthly 20% left")
    const [, first, second] = select.options
    expect(first.value).not.toBe(second.value)
    expect(select.options.filter((option: { value: string }) => option.value === first.value)).toHaveLength(1)
    expect(select.options.filter((option: { value: string }) => option.value === second.value)).toHaveLength(1)

    select.onSelect(first)
    expect(alert.title).toContain("1. First")
    const firstDetails = alert.message
    select.onSelect(second)
    expect(alert.title).toContain("2. Second")
    expect(alert.message).toBe(firstDetails)
    expect(alert.message).toContain("12% used")
  })

  it("makes every account reachable through the host selector in a bounded terminal", async () => {
    const accounts = Array.from({ length: 20 }, (_, index) => ({
      apiKey: `secret-key-${String(index + 1).padStart(4, "0")}`,
      label: index === 9 ? "Account 10\n\nInjected option" : `Account ${index + 1}`,
      addedAt: index,
      enabled: true,
      role: "primary" as const,
    }))
    saveAccounts({ version: 1, accounts, rotationIndex: 0 })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-09-15T08:00:00.000Z" },
        weekly: { status: "ok", percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 90, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    })) as typeof fetch
    let layer: any
    let select: any
    let alert: any
    let sessionCalls = 0

    await tuiPlugin.tui({
      client: { session: { command() { sessionCalls++ }, prompt() { sessionCalls++ } } },
      keymap: { registerLayer(value: unknown) { layer = value; return () => {} } },
      ui: {
        toast() {},
        DialogSelect(input: unknown) { select = input; return input },
        DialogAlert(input: unknown) { alert = input; return input },
        dialog: { replace(render: () => unknown) { render() }, setSize() {} },
      },
    } as any, undefined, {} as any)

    try {
      await layer.commands[0].run()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(select.options).toHaveLength(21)
    expect(select.options.map((option: { title: string }) => option.title)).toEqual([
      "Aggregate  5-hour 1760% left \u00b7 weekly 1200% left \u00b7 monthly 200% left",
      ...accounts.map((account, index) => `${index + 1}. ${account.label.replace(/\s+/g, " ")}  [primary]  key ...${account.apiKey.slice(-4)}  remaining`),
    ])
    expect(select.options[0].value).toBe("aggregate")
    expect(select.options.slice(1).map((option: { value: string }) => option.value)).toEqual(
      accounts.map((_, index) => String(index)),
    )
    expect(select.options[10].title).toContain("Account 10 Injected option")
    expect(JSON.stringify(select.options)).not.toContain("secret-key-")
    select.onSelect(select.options[0])
    expect(alert.message).toContain("1760% left")
    expect(alert.message).not.toContain("secret-key-")
    select.onSelect(select.options[20])
    expect(alert.title).toContain("20. Account 20")
    expect(alert.message).toContain("5-hour")
    expect(alert.message).toContain("monthly")
    expect(sessionCalls).toBe(0)
  })

  it("opens the empty message directly without a selectable account or session call", async () => {
    let layer: any
    let selectCalls = 0
    let alert: any
    let sessionCalls = 0

    await tuiPlugin.tui({
      client: { session: { command() { sessionCalls++ }, prompt() { sessionCalls++ } } },
      keymap: { registerLayer(value: unknown) { layer = value; return () => {} } },
      ui: {
        toast() {},
        DialogSelect() { selectCalls++; return undefined },
        DialogAlert(input: unknown) { alert = input; return input },
        dialog: { replace(render: () => unknown) { render() }, setSize() {} },
      },
    } as any, undefined, {} as any)

    await layer.commands[0].run()

    expect(selectCalls).toBe(0)
    expect(alert).toMatchObject({ message: "No Go accounts configured." })
    expect(sessionCalls).toBe(0)
  })

  it("shows an error toast when the usage command fails", async () => {
    let layer: any
    const toastCalls: unknown[] = []

    await tuiPlugin.tui({
      keymap: {
        registerLayer(value: unknown) {
          layer = value
          return () => {}
        },
      },
      ui: {
        toast(input: unknown) { toastCalls.push(input) },
        dialog: {
          replace() { throw new Error("dialog unavailable") },
          setSize() {},
          clear() {},
        },
      },
    } as any, undefined, {} as any)

    await expect(layer.commands[0].run()).resolves.toBeUndefined()
    const log = readFileSync(join(tmpHome, ".config", "opencode", "oc-go-multi-auth.log"), "utf-8")
    expect(log).toContain('"msg":"usage report failed"')
    expect(log).toContain('"error":"dialog unavailable"')
    expect(toastCalls).toEqual([
      {
        variant: "info",
        message: "Loading OpenCode Go usage...",
        duration: 2_000,
      },
      {
        variant: "error",
        message: "Failed to load OpenCode Go usage.",
      },
    ])
  })
})

describe("OpenCode V2 adapter", () => {
  it("registers a key method and redirects every opencode-go model to the native provider subpath", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const harness = createV2Context()

    await plugin.setup(harness.context)

    expect(harness.order).toEqual([
      "integration.transform",
      "command.transform",
      "catalog.transform",
      "integration.connection.active",
      "integration.connect.key",
    ])
    expect(harness.integrations.get("opencode-go")?.name).toBe("OpenCode Go")
    expect(harness.methods.get("opencode-go")).toEqual([{ type: "key", label: "Go API key" }])
    expect(harness.connections).toEqual([{ integrationID: "opencode-go", key: "key-a" }])
    expect(harness.catalogProvider.integrationID).toBe("opencode-go")
    expect(harness.catalogProvider.package).toBe("oc-go-multi-auth/v2/provider")
    expect(harness.catalogProvider.settings?.ocGoMultiAuthNativePackage).toBe(
      "aisdk:@ai-sdk/openai-compatible",
    )
    expect([...harness.catalogModels.values()].map((model) => [
      model.package,
      model.settings?.ocGoMultiAuthNativePackage,
    ])).toEqual([
      ["oc-go-multi-auth/v2/provider", "aisdk:@ai-sdk/openai-compatible"],
      ["oc-go-multi-auth/v2/provider", "aisdk:@ai-sdk/anthropic"],
      ["oc-go-multi-auth/v2/provider", "aisdk:@ai-sdk/openai"],
    ])
  })

  for (const source of [
    "aisdk:@ai-sdk/openai-compatible",
    "aisdk:@ai-sdk/anthropic",
    "aisdk:@ai-sdk/openai",
  ]) {
    it(`normalizes ${source} settings before redirecting to the native wrapper`, async () => {
      saveAccounts({
        version: 1,
        accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
        rotationIndex: 0,
      })
      const harness = createV2Context({
        providerPackage: source,
        providerCanonical: source === "aisdk:@ai-sdk/openai-compatible" ? "go-canonical" : undefined,
        providerSettings: {
          apiKey: "host-key",
          headers: { "X-Shared": "settings", "X-Settings": "kept" },
          extraBody: { nested: { settings: true, winner: "extra" }, extra: true },
          body: { constructor: true },
          customOption: "kept",
          provider: "stale-provider",
        },
        providerHeaders: { "x-shared": "catalog", "X-Catalog": "kept" },
        providerBody: { nested: { catalog: true, winner: "body" }, catalog: true },
        models: [{ id: "model", providerID: "opencode-go" }],
      })

      await plugin.setup(harness.context)

      expect(harness.catalogProvider.package).toBe("oc-go-multi-auth/v2/provider")
      expect(harness.catalogProvider.settings).toEqual({
        apiKey: "host-key",
        body: { constructor: true },
        customOption: "kept",
        ...(source === "aisdk:@ai-sdk/openai-compatible" ? { provider: "go-canonical" } : { provider: "stale-provider" }),
        ocGoMultiAuthNativePackage: source,
      })
      expect(harness.catalogProvider.headers).toEqual({
        "x-shared": "catalog",
        "X-Settings": "kept",
        "X-Catalog": "kept",
      })
      expect(harness.catalogProvider.body).toEqual({
        nested: { settings: true, catalog: true, winner: "body" },
        extra: true,
        catalog: true,
      })
    })
  }

  it("replaces duplicate setup registrations without advancing or reconnecting", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const harness = createV2Context()

    await plugin.setup(harness.context)
    await plugin.setup(harness.context)

    expect(harness.methods.get("opencode-go")).toEqual([{ type: "key", label: "Go API key" }])
    expect(harness.connections).toEqual([{ integrationID: "opencode-go", key: "key-a" }])
    expect(harness.integrationRegistrations).toBe(1)
    expect(harness.catalogRegistrations).toBe(1)
    expect(harness.commandRegistrations).toBe(1)
    expect(loadRotationState()).toEqual({ lastUsedIndex: -1 })
  })

  it("is idempotent across cumulative setup contexts", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const harness = createV2Context({
      providerSettings: { extraBody: { once: true } },
      providerBody: { winner: "body" },
    })

    const firstCleanup = await plugin.setup(harness.context)
    const secondCleanup = await plugin.setup({ ...harness.context })

    expect(harness.catalogProvider.package).toBe("oc-go-multi-auth/v2/provider")
    expect(harness.catalogProvider.settings?.ocGoMultiAuthNativePackage).toBe(
      "aisdk:@ai-sdk/openai-compatible",
    )
    expect(harness.catalogProvider.body).toEqual({ once: true, winner: "body" })
    expect(harness.catalogRegistrations).toBe(2)
    await firstCleanup?.()
    await secondCleanup?.()
  })

  it("leaves unsupported provider and model packages to the host", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const harness = createV2Context({
      providerPackage: "aisdk:@ai-sdk/google",
      providerSettings: { extraBody: { untouched: true } },
      models: [{ id: "model", providerID: "opencode-go", package: "custom-provider" }],
    })

    await plugin.setup(harness.context)

    expect(harness.catalogProvider.package).toBe("aisdk:@ai-sdk/google")
    expect(harness.catalogProvider.settings).toEqual({ extraBody: { untouched: true } })
    expect(harness.catalogModels.get("model")?.package).toBe("custom-provider")
  })

  it("keeps the catalog override active when optional connection priming fails", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const harness = createV2Context({ failPriming: true })

    await expect(plugin.setup(harness.context)).resolves.toBeFunction()

    expect(harness.catalogProvider.package).toBe("oc-go-multi-auth/v2/provider")
    expect(harness.connections).toEqual([])
  })

  it("registers the key method but leaves the catalog unchanged until restart when no accounts exist", async () => {
    const harness = createV2Context()

    await expect(plugin.setup(harness.context)).resolves.toBeFunction()

    expect(harness.catalogProvider.package).toBe("aisdk:@ai-sdk/openai-compatible")
    expect(harness.connections).toEqual([])
    expect(harness.catalogRegistrations).toBe(0)
    expect(harness.commandRegistrations).toBe(1)
    expect(harness.order).toEqual(["integration.transform", "command.transform"])
  })

  it("does not replace an already-active connection", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "key-a", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const harness = createV2Context({ alreadyConnected: true })

    await plugin.setup(harness.context)

    expect(harness.connections).toEqual([])
    expect(harness.order).toEqual([
      "integration.transform",
      "command.transform",
      "catalog.transform",
      "integration.connection.active",
    ])
  })

  it("registers go-usage via command.transform even with zero accounts", async () => {
    const harness = createV2Context()
    await plugin.setup(harness.context)

    expect(harness.commands.map((command) => command.name)).toEqual(["go-usage"])
    await harness.commands[0].execute({ sessionID: "sess-empty" })
    expect(harness.synthetics[0]).toMatchObject({ sessionID: "sess-empty" })
    expect(harness.synthetics[0].text).toContain("No Go accounts configured.")
  })

  it("posts the go-usage report through session.synthetic without sending a full key", async () => {
    saveAccounts({
      version: 1,
      accounts: [{ apiKey: "secret-key-x1ab", label: "Work", addedAt: 10, enabled: true, role: "primary" }],
      rotationIndex: 0,
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.headers.get("Authorization")).toBe("Bearer secret-key-x1ab")
      return Response.json({
        usage: {
          rolling: { status: "ok", percent: 12, resetsAt: "2026-09-15T08:00:00.000Z" },
          weekly: { status: "ok", percent: 40, resetsAt: "2026-09-20T00:00:00.000Z" },
          monthly: { status: "ok", percent: 90, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      })
    }) as typeof fetch
    const harness = createV2Context()

    try {
      await plugin.setup(harness.context)
      const command = harness.commands.find((entry) => entry.name === "go-usage")
      expect(command).toBeDefined()
      await command!.execute({ sessionID: "sess-1" })

      expect(harness.synthetics).toHaveLength(1)
      expect(harness.synthetics[0].sessionID).toBe("sess-1")
      expect(harness.synthetics[0].text).toContain("Aggregate available")
      expect(harness.synthetics[0].text).toContain("   5-hour   88% left")
      expect(harness.synthetics[0].text).toContain("   weekly   60% left")
      expect(harness.synthetics[0].text).toContain("   monthly  10% left")
      expect(harness.synthetics[0].text).toContain("1. Work  [primary]  key ...x1ab  remaining")
      expect(JSON.stringify(harness.synthetics)).not.toContain("secret-key-x1ab")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
