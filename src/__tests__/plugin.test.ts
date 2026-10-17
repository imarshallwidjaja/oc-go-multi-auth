import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import type { AuthHook, Plugin as V1Plugin } from "@opencode-ai/plugin"
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
  it("offers the stock single-key method first, then Add Go Account, and never writes from the loader", async () => {
    expect(plugin.id).toBe("oc-go-multi-auth")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10)], rotationIndex: 0 })
    const before = readFileSync(accountsPath(), "utf-8")
    let authWrites = 0
    const hooks = await plugin.server(pluginInput({ auth: { set: async () => { authWrites++ } } }))

    expect(hooks.auth!.provider).toBe("opencode-go")
    const methods = hooks.auth!.methods
    expect(methods.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: "api", label: "Go API key" },
      { type: "oauth", label: "Add Go Account" },
    ])
    expect(methods[0]).toEqual({ type: "api", label: "Go API key" })
    const prompts = methods[1].prompts!
    expect(prompts.map((prompt) => [prompt.type, prompt.key, prompt.message])).toEqual([
      ["text", "apiKey", "Go API key"],
      ["text", "label", "Account label"],
      ["select", "role", "Account role"],
    ])
    expect(prompts[2].type === "select" && prompts[2].options.map((option) => option.value)).toEqual(["primary", "overage_fallback"])
    const options = await hooks.auth!.loader!(async () => ({ type: "api", key: "key-a" }), {} as any)
    expect(options.apiKey).toBe("")
    expect(typeof options.fetch).toBe("function")
    expect(authWrites).toBe(0)
    expect(readFileSync(accountsPath(), "utf-8")).toBe(before)
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

describe("OpenCode V1 Add Go Account connector", () => {
  type OAuthMethod = Extract<AuthHook["methods"][number], { type: "oauth" }>

  async function connector() {
    const hooks = await plugin.server(pluginInput())
    const method = hooks.auth!.methods.find((candidate) => candidate.label === "Add Go Account")
    if (method?.type !== "oauth") throw new Error("Add Go Account is not an OAuth-shaped method")
    return method as OAuthMethod
  }

  async function hostCallback(authorization: Awaited<ReturnType<OAuthMethod["authorize"]>>) {
    expect(authorization.method).toBe("auto")
    return (authorization as Extract<typeof authorization, { method: "auto" }>).callback()
  }

  const accountFile = () => readFileSync(accountsPath(), "utf-8")
  const logText = () => readFileSync(join(tmpHome, ".config", "opencode", "oc-go-multi-auth.log"), "utf-8")

  it("adds the account only in the callback, keeps earlier accounts, and returns the key for the host connection", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-old-0001", 10, "Old")], rotationIndex: 0 })
    const before = accountFile()
    const method = await connector()

    const authorization = await method.authorize({ apiKey: "  go-new-key-1234  ", label: " Work ", role: "overage_fallback" })
    expect(authorization.url).toBe("https://opencode.ai/auth")
    expect(authorization.instructions).not.toContain(":")
    expect(JSON.stringify(authorization)).not.toContain("go-new-key-1234")
    expect(accountFile()).toBe(before)

    expect(await hostCallback(authorization)).toEqual({ type: "success", key: "go-new-key-1234" })
    expect(loadAccounts().accounts).toMatchObject([
      { apiKey: "key-old-0001", label: "Old", role: "primary" },
      { apiKey: "go-new-key-1234", label: "Work", role: "overage_fallback", enabled: true },
    ])
    expect(logText()).not.toContain("go-new-key-1234")
  })

  it("saves once per authorization across repeated and concurrent callbacks, and never mixes two authorizations", async () => {
    const method = await connector()
    const first = await method.authorize({ apiKey: "go-key-aaaa", label: "Alpha", role: "primary" }) as any
    const second = await method.authorize({ apiKey: "go-key-bbbb", label: "Beta", role: "overage_fallback" }) as any
    // Replaced before its callback ran, as when the host's pending entry is overwritten.
    await method.authorize({ apiKey: "go-key-cccc", label: "Abandoned", role: "primary" })

    const [one, two] = await Promise.all([second.callback(), second.callback()])
    expect(one).toBe(two)
    expect(await second.callback()).toBe(one)
    expect(await first.callback()).toEqual({ type: "success", key: "go-key-aaaa" })
    expect(await first.callback()).toEqual({ type: "success", key: "go-key-aaaa" })
    expect(loadAccounts().accounts.map(({ apiKey, label, role }) => [apiKey, label, role])).toEqual([
      ["go-key-bbbb", "Beta", "overage_fallback"],
      ["go-key-aaaa", "Alpha", "primary"],
    ])

    // A new authorization is a new add, consistent with duplicate keys being allowed.
    await (await method.authorize({ apiKey: "go-key-aaaa", label: "Alpha again", role: "primary" }) as any).callback()
    expect(loadAccounts().accounts.map((account) => account.label)).toEqual(["Beta", "Alpha", "Alpha again"])
  })

  it("rejects blank, missing, or invalid inputs without writing or exposing the key", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-old-0001", 10, "Old")], rotationIndex: 0 })
    const before = accountFile()
    const method = await connector()
    const [keyPrompt, labelPrompt] = method.prompts! as Array<{ validate?: (value: string) => string | undefined }>
    expect(keyPrompt.validate!("   ")).toBe("Enter a Go API key")
    expect(keyPrompt.validate!("go-key")).toBeUndefined()
    expect(labelPrompt.validate!("")).toBe("Enter an account label")

    for (const inputs of [
      undefined,
      {},
      { apiKey: "  ", label: "Work", role: "primary" },
      { apiKey: "secret-go-key-9999", role: "primary" },
      { apiKey: "secret-go-key-9999", label: "   ", role: "primary" },
      { apiKey: "secret-go-key-9999", label: "Work", role: "paid" },
      { apiKey: "secret-go-key-9999", label: "Work", role: "" },
    ]) {
      const authorization = await method.authorize(inputs)
      expect(authorization.instructions).not.toContain(":")
      expect(JSON.stringify(authorization)).not.toContain("secret-go-key-9999")
      expect(await hostCallback(authorization)).toEqual({ type: "failed" })
    }
    expect(accountFile()).toBe(before)
  })

  it("defaults an omitted role to primary for direct HTTP callers", async () => {
    const method = await connector()
    await (await method.authorize({ apiKey: "go-key-dddd", label: "Direct" }) as any).callback()
    expect(loadAccounts().accounts).toMatchObject([{ apiKey: "go-key-dddd", label: "Direct", role: "primary" }])
  })

  it("fails safely and leaves the account file in place when storage is corrupt or busy", async () => {
    const method = await connector()
    writeFileSync(accountsPath(), "{ not json")
    const corrupt = await method.authorize({ apiKey: "secret-go-key-corrupt", label: "Work", role: "primary" })
    expect(await hostCallback(corrupt)).toEqual({ type: "failed" })
    expect(accountFile()).toBe("{ not json")

    saveAccounts({ version: 1, accounts: [goAccount("key-old-0001", 10, "Old")], rotationIndex: 0 })
    const before = accountFile()
    const lock = `${accountsPath()}.lock`
    writeFileSync(lock, "held by another edit\n")
    try {
      const busy = await method.authorize({ apiKey: "secret-go-key-busy", label: "Work", role: "primary" })
      expect(await hostCallback(busy)).toEqual({ type: "failed" })
    } finally {
      rmSync(lock, { force: true })
    }
    expect(accountFile()).toBe(before)
    expect(logText()).toContain('"msg":"add go account failed"')
    expect(logText()).toContain("Account file is busy")
    expect(logText()).not.toContain("secret-go-key-")
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

type FakeCredential = { id: string; label: string; value: { type: "key"; key: string } | { type: "oauth" | "external" } }

/**
 * OpenCode 2's Go credential store and live event bus as plugins see them
 * (core v2.0.28 Credential and Bus). Contexts sharing one store model plugin
 * instances in one server: every live subscription receives every event, and
 * a subscription sees only events published after its first read.
 */
function fakeCredentialStore(initial: Array<{ id: string; key?: string; method?: "oauth" | "external" }> = []) {
  let created = 0
  const credentials: FakeCredential[] = initial.map(({ id, key, method }) => ({
    id,
    label: "OpenCode Go",
    value: method ? { type: method } : { type: "key", key: key ?? `${id}-key` },
  }))
  const listeners = new Set<(event: unknown) => void>()
  const store = {
    credentials,
    listeners,
    /** Credential ids and env names passed to connection.resolve, in call order. */
    resolved: [] as string[],
    /** An environment variable connection listed after the stored credentials. */
    env: undefined as string | undefined,
    activeID: credentials.at(-1)?.id as string | undefined,
    getError: undefined as Error | undefined,
    /** Runs once a listing has been taken, before integration.get returns it; the listing waits for a returned promise. */
    afterList: undefined as (() => Promise<void> | void) | undefined,
    /** Thrown by every live event subscription at its next wake-up. */
    streamError: undefined as Error | undefined,
    /** Thrown by the next connection.resolve only. */
    resolveError: undefined as Error | undefined,
    /** Runs inside connection.resolve before it returns. */
    onResolve: undefined as (() => Promise<void> | void) | undefined,
    publish(event: unknown) {
      for (const listener of [...listeners]) listener(event)
    },
    /** Like Credential.create with activation: commit, then credential.updated and credential.switched. */
    create(value: FakeCredential["value"] | string) {
      const id = `crd_new_${++created}`
      const label = credentials.length === 0 ? "OpenCode Go" : `OpenCode Go ${credentials.length + 1}`
      credentials.push({ id, label, value: typeof value === "string" ? { type: "key", key: value } : value })
      store.activeID = id
      store.publish({ type: "credential.updated", data: {} })
      store.publish({ type: "credential.switched", data: { integrationID: "opencode-go", credentialID: id } })
      return id
    },
    activate(id: string) {
      store.activeID = id
      store.publish({ type: "credential.switched", data: { integrationID: "opencode-go", credentialID: id } })
    },
    /** Removes a credential; removing the active one switches to the newest remaining. */
    remove(id: string) {
      credentials.splice(credentials.findIndex((credential) => credential.id === id), 1)
      store.publish({ type: "credential.updated", data: {} })
      if (store.activeID === id) store.activate(credentials.at(-1)?.id ?? (null as never))
    },
    connections() {
      const stored = credentials.map((credential) => ({
        type: "credential",
        id: credential.id,
        label: credential.label,
        method: credential.value.type,
      })).toReversed()
      return [...stored, ...(store.env ? [{ type: "env", name: store.env }] : [])]
    },
  }
  return store
}

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
  /** A credential store shared with other contexts; by default each context has its own. */
  store?: ReturnType<typeof fakeCredentialStore>
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
  const store = options.store ?? fakeCredentialStore(options.connected ? [{ id: "existing", key: "host-key" }] : [])
  const queues = new Set<unknown[]>()
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
        const signal = requestOptions?.signal
        if (signal) subscriptions.push(signal)
        return (async function* () {
          // Like the SDK adapter, the host subscription starts at the first read.
          const queue: unknown[] = []
          let wake: (() => void) | undefined
          const listener = (event: unknown) => {
            queue.push(event)
            wake?.()
          }
          store.listeners.add(listener)
          queues.add(queue)
          try {
            while (!signal?.aborted) {
              if (store.streamError) throw store.streamError
              if (queue.length > 0) {
                yield queue.shift()
                continue
              }
              await new Promise<void>((resolve) => {
                wake = resolve
                signal?.addEventListener("abort", () => resolve(), { once: true })
              })
            }
          } finally {
            store.listeners.delete(listener)
            queues.delete(queue)
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
      get: async ({ integrationID }: { integrationID: string }) => {
        if (store.getError) throw store.getError
        if (integrationID !== "opencode-go") throw new Error(`unexpected integration ${integrationID}`)
        const connections = store.connections()
        await store.afterList?.()
        return { location: {}, data: { id: "opencode-go", name: "OpenCode Go", methods: [], connections } }
      },
      connection: {
        active: async () => store.connections()[0],
        resolve: async (connection: { type: string; id?: string; name?: string }) => {
          store.resolved.push(connection.id ?? `env:${connection.name}`)
          await store.onResolve?.()
          const failure = store.resolveError
          store.resolveError = undefined
          if (failure) throw failure
          if (connection.type === "env") return { type: "key", key: "env-key" }
          return store.credentials.find((credential) => credential.id === connection.id)?.value
        },
      },
      connect: {
        key: async (input: { integrationID: string; key: string }) => {
          if (options.connectError) throw options.connectError
          connects.push(input)
          store.create(input.key)
        },
      },
    },
  }
  const call = async (method: string, input: unknown, signal: AbortSignal = new AbortController().signal) => rpc!.handlers[method](input, {
    signal,
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  })
  const pendingEvents = () => [...queues].reduce((total, queue) => total + queue.length, 0)
  return { context, hooks, connects, disposed, call, emit: store.publish, owner, store, subscriptions, pendingEvents, get rpc() { return rpc } }
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

  it("stops listening for session and credential events on cleanup", async () => {
    saveAccounts({ version: 1, accounts: [goAccount("key-a", 10)], rotationIndex: 0 })
    const host = fakeV2Context({ connected: true })
    const cleanup = (await setupV2(host.context))!
    // The credential importer and the session-end watcher.
    expect(host.subscriptions).toHaveLength(2)
    expect(host.subscriptions.some((signal) => signal.aborted)).toBe(false)
    await cleanup()
    cleanups.length = 0
    expect(host.subscriptions.every((signal) => signal.aborted)).toBe(true)
    await until(() => host.store.listeners.size === 0 ? true : undefined, "subscriptions closed")
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

  describe("credential import", () => {
    const logPath = () => join(tmpHome, ".config", "opencode", "oc-go-multi-auth.log")
    /** Log text written after the returned mark was taken. */
    const logFrom = () => {
      const start = readFileSync(logPath(), "utf-8").length
      return () => readFileSync(logPath(), "utf-8").slice(start)
    }
    const keys = () => loadAccounts().accounts.map((account) => account.apiKey)
    const accountCount = (count: number) => until(() => loadAccounts().accounts.length === count ? true : undefined, `${count} accounts`)
    const pool = (...apiKeys: string[]) => saveAccounts({
      version: 1,
      accounts: apiKeys.map((apiKey, index) => goAccount(apiKey, 10 + index)),
      rotationIndex: 0,
    })

    it("imports a key connected after startup, never one it started with, and never re-adds a removed account", async () => {
      pool("key-a")
      const store = fakeCredentialStore([{ id: "crd_old", key: "old-host-key" }, { id: "crd_oauth", method: "oauth" }])
      const host = fakeV2Context({ store })
      await setupV2(host.context)
      expect(host.connects).toEqual([])
      const log = logFrom()

      const id = store.create("new-host-key-7777")
      await accountCount(2)
      expect(loadAccounts().accounts[1]).toMatchObject({ apiKey: "new-host-key-7777", label: "OpenCode Go 3", role: "primary", enabled: true })
      expect(store.resolved).toEqual([id])
      await until(() => log().includes("account imported") ? true : undefined, "import log")
      expect(log()).toContain("restart the OpenCode server")
      expect(log()).not.toContain("new-host-key-7777")

      // Pool and host credentials are managed independently from here on.
      const listed = await host.call("list", {}) as { accounts: Array<{ id: string }> }
      await host.call("remove", { id: listed.accounts[1].id })
      store.activate("crd_old")
      store.activate(id)
      store.remove(id)
      // Reconciles run in event order, so once a later key is in, the events above were handled.
      const later = store.create("later-host-key")
      await accountCount(2)
      expect(keys()).toEqual(["key-a", "later-host-key"])
      expect(store.resolved).toEqual([id, later])
    })

    it("imports with an empty pool, and skips the key the startup activation connected", async () => {
      const empty = fakeV2Context()
      const stopEmpty = (await setupV2(empty.context))!
      empty.store.create("first-host-key")
      await accountCount(1)
      // The running server has no pool until it restarts.
      expect(empty.hooks).toEqual([])
      // A watcher whose startup listing fails holds the history only until it gives up.
      const unlisted = fakeV2Context()
      unlisted.store.getError = new Error("listing down")
      const stopUnlisted = (await setupV2(unlisted.context))!
      // Restart. The new host store reuses the credential id the stopped server imported,
      // so this also checks that the stopped server's import history was dropped.
      await stopUnlisted()
      await stopEmpty()

      pool("key-a")
      const before = readFileSync(accountsPath(), "utf-8")
      const log = logFrom()
      const host = fakeV2Context()
      await setupV2(host.context)
      expect(host.connects).toEqual([{ integrationID: "opencode-go", key: "key-a" }])
      await until(() => log().includes("an account already holds this key") ? true : undefined, "duplicate skip")
      expect(host.store.resolved).toEqual(["crd_new_1"])
      expect(readFileSync(accountsPath(), "utf-8")).toBe(before)
    })

    it("catches a key connected after the startup listing but before the subscription", async () => {
      pool("key-a")
      const host = fakeV2Context({ connected: true })
      let id: string | undefined
      host.store.afterList = () => {
        host.store.afterList = undefined
        // Its events reach no subscriber yet.
        id = host.store.create("startup-race-key")
      }
      await setupV2(host.context)
      await accountCount(2)
      expect(keys()).toEqual(["key-a", "startup-race-key"])
      expect(host.store.resolved).toEqual([id!])
    })

    it("imports two keys connected in quick succession under their own credentials", async () => {
      pool("key-a")
      const host = fakeV2Context({ connected: true })
      await setupV2(host.context)
      const ids = [host.store.create("burst-key-1"), host.store.create("burst-key-2")]
      await accountCount(3)
      expect(keys()).toEqual(["key-a", "burst-key-1", "burst-key-2"])
      expect(loadAccounts().accounts.map((account) => account.label)).toEqual([undefined, "OpenCode Go 2", "OpenCode Go 3"])
      expect(host.store.resolved).toEqual(ids)
    })

    it("reads only new Go key credentials, and only while the provider belongs to the Go integration", async () => {
      pool("key-a")
      const host = fakeV2Context({ connected: true, integrationID: "opencode" })
      host.store.env = "OPENCODE_API_KEY"
      await setupV2(host.context)
      let reads = 0
      let rebindRead = false
      let rebound: string | undefined
      host.owner.onRead = () => {
        reads++
        if (rebound && host.store.resolved.includes(rebound)) rebindRead = true
      }
      host.store.create({ type: "oauth" })
      host.store.create({ type: "external" })
      const consoleTime = host.store.create("console-time-key")
      // The importer asked who owns the provider and stopped there.
      await until(() => reads > 0 ? true : undefined, "binding check")
      expect(host.store.resolved).toEqual([])

      host.owner.integrationID = "opencode-go"
      host.store.activate("existing")
      await accountCount(2)
      expect(keys()).toEqual(["key-a", "console-time-key"])
      // Never an OAuth, external or environment connection, nor the startup credential.
      expect(host.store.resolved).toEqual([consoleTime])

      // A rebind while the key is read keeps it out; it is retried at the next credential event.
      host.store.onResolve = () => { host.owner.integrationID = "opencode" }
      rebound = host.store.create("rebound-key")
      await until(() => rebindRead ? true : undefined, "binding recheck after the read")
      host.store.onResolve = undefined
      host.owner.integrationID = "opencode-go"
      host.store.activate("existing")
      await accountCount(3)
      // Read twice: the first read was dropped, so the key was imported by the retry.
      expect(host.store.resolved).toEqual([consoleTime, rebound, rebound])
    })

    it("reads and appends a new key once when two plugin instances share the server", async () => {
      pool("key-a")
      const store = fakeCredentialStore([{ id: "existing", key: "host-key" }])
      await setupV2(fakeV2Context({ store }).context)
      await setupV2(fakeV2Context({ store }).context)
      let listings = 0
      store.afterList = () => { listings++ }
      // The first read waits until both instances have listed the new credential.
      store.onResolve = () => until(() => listings >= 2 ? true : undefined, "both listings").then(() => {})
      const id = store.create("shared-key")
      await accountCount(2)
      store.onResolve = undefined
      // The instance that waited for the first import settled the credential without reading it.
      const next = store.create("next-key")
      await accountCount(3)
      expect(keys()).toEqual(["key-a", "shared-key", "next-key"])
      expect(store.resolved).toEqual([id, next])
    })

    it("keeps the import history of each account file apart", async () => {
      pool("key-a")
      const store = fakeCredentialStore([{ id: "existing", key: "host-key" }])
      await setupV2(fakeV2Context({ store }).context)
      const id = store.create("first-home-key")
      await accountCount(2)

      // A watcher of another account file decides the same credential id for itself.
      const otherHome = mkdtempSync(join(tmpdir(), "go-plugin-other-home-"))
      process.env.HOME = otherHome
      try {
        saveAccounts({ version: 1, accounts: [goAccount("key-b", 10)], rotationIndex: 0 })
        const other = fakeCredentialStore([{ id: "existing", key: "host-key" }])
        const cleanup = (await setupV2(fakeV2Context({ store: other }).context))!
        expect(other.create("other-home-key")).toBe(id)
        await accountCount(2)
        expect(keys()).toEqual(["key-b", "other-home-key"])
        await cleanup()
      } finally {
        process.env.HOME = tmpHome
        rmSync(otherHome, { recursive: true, force: true })
      }
      expect(keys()).toEqual(["key-a", "first-home-key"])
    })

    it("never re-adds a removed key through an instance that refused it while another imported it", async () => {
      pool("key-a")
      const store = fakeCredentialStore([{ id: "crd_old", key: "old-host-key" }])
      const go = fakeV2Context({ store })
      const consoleOwned = fakeV2Context({ store, integrationID: "opencode" })
      // Subscribed first, so it considers the new credential first and refuses it.
      await setupV2(consoleOwned.context)
      await setupV2(go.context)
      let refusals = 0
      consoleOwned.owner.onRead = () => { refusals++ }
      const id = store.create("new-host-key")
      await accountCount(2)
      await until(() => refusals > 0 ? true : undefined, "refusal by the Console-owned instance")

      const listed = await go.call("list", {}) as { accounts: Array<{ id: string }> }
      await go.call("remove", { id: listed.accounts[1].id })
      consoleOwned.owner.integrationID = "opencode-go"
      store.activate("crd_old")
      const later = store.create("later-host-key")
      await until(() => keys().includes("later-host-key") ? true : undefined, "later import")
      // Only the formerly refusing instance can import this one. It handles events in
      // order, so once this key is in, it has reconsidered the removed key's credential.
      go.owner.integrationID = "opencode"
      const sentinel = store.create("sentinel-key")
      await until(() => keys().includes("sentinel-key") ? true : undefined, "sentinel import")
      expect(keys()).toEqual(["key-a", "later-host-key", "sentinel-key"])
      // Each credential is read by one instance only.
      expect(store.resolved).toEqual([id, later, sentinel])
    })

    it("keeps the import history while a starting instance still reads its baseline, so a key removed meanwhile stays removed", async () => {
      pool("key-a")
      const store = fakeCredentialStore([{ id: "existing", key: "host-key" }])
      let releaseBaseline!: () => void
      const baselineHeld = new Promise<void>((resolve) => { releaseBaseline = resolve })
      // The late instance has listed the connections, without the key below, but not yet returned them.
      store.afterList = () => {
        store.afterList = undefined
        return baselineHeld
      }
      const late = setupV2(fakeV2Context({ store }).context)
      await until(() => store.afterList === undefined ? true : undefined, "late baseline listing")

      // Meanwhile the only fully started instance imports the key, the user removes it, and the instance stops.
      const early = fakeV2Context({ store })
      const stopEarly = (await setupV2(early.context))!
      store.create("removed-host-key")
      await accountCount(2)
      const listed = await early.call("list", {}) as { accounts: Array<{ id: string }> }
      await early.call("remove", { id: listed.accounts[1].id })
      await stopEarly()

      releaseBaseline()
      await late
      // Reconciles run in event order, so once this key is in, the late instance's catch-up listing has been handled.
      const sentinel = store.create("sentinel-key")
      await until(() => keys().includes("sentinel-key") ? true : undefined, "sentinel import")
      expect(keys()).toEqual(["key-a", "sentinel-key"])
      expect(store.resolved).toEqual(["crd_new_1", sentinel])
    })

    it("retries after a transient failure, and stops at a corrupt account file after one backup", async () => {
      pool("key-a")
      const host = fakeV2Context({ connected: true })
      await setupV2(host.context)
      const log = logFrom()
      host.store.resolveError = new Error("store refused retry-key-secret")
      const id = host.store.create("retry-key-secret")
      await until(() => log().includes("could not be read") ? true : undefined, "read failure")
      expect(log()).not.toContain("retry-key-secret")
      // The credential.switched event that follows the creation retries it.
      await accountCount(2)
      expect(host.store.resolved).toEqual([id, id])

      const configDir = join(tmpHome, ".config", "opencode")
      const backups = () => readdirSync(configDir).filter((name) => name.startsWith("opencode-go-accounts.json.bak.")).length
      const before = backups()
      writeFileSync(accountsPath(), "{broken")
      host.store.create("corrupt-key-1")
      await until(() => log().includes("account import stopped") ? true : undefined, "import stop")
      // The importer unsubscribed; only the session-end watcher still listens.
      await until(() => host.store.listeners.size === 1 ? true : undefined, "importer unsubscribed")
      host.store.create("corrupt-key-2")
      expect(backups()).toBe(before + 1)
      expect(readFileSync(accountsPath(), "utf-8")).toBe("{broken")
    })

    it("keeps host error text out of the log when a later listing or the event stream fails", async () => {
      pool("key-a")
      const host = fakeV2Context({ connected: true })
      await setupV2(host.context)
      const log = logFrom()
      const importerEntries = () => log().split("\n").filter((line) => line.includes('"msg":"account import'))
      host.store.getError = new Error("cannot decode sk-listing-secret")
      host.store.create("listing-key")
      await until(() => log().includes("could not be listed") ? true : undefined, "listing failure")
      host.store.getError = undefined

      host.store.streamError = new Error("stream closed while encoding sk-stream-secret")
      host.store.publish({ type: "credential.updated", data: {} })
      await until(() => log().includes("the event stream failed") ? true : undefined, "stream failure")
      expect(importerEntries().length).toBeGreaterThan(1)
      for (const entry of importerEntries()) {
        expect(entry).not.toContain("secret")
        expect(entry).toContain('"error":"Error"')
      }
    })

    it("admits no import after cleanup starts, and cleanup waits for a read in progress", async () => {
      pool("key-a")
      const host = fakeV2Context({ connected: true })
      const cleanup = (await setupV2(host.context))!
      cleanups.length = 0
      let release: (() => void) | undefined
      host.store.onResolve = () => new Promise<void>((resolve) => { release = resolve })
      host.store.create("late-key")
      const unblock = await until(() => release, "read in progress")

      let finished = false
      const stopping = cleanup().then(() => { finished = true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(finished).toBe(false)
      unblock()
      await stopping
      expect(keys()).toEqual(["key-a"])
      await until(() => host.store.listeners.size === 0 ? true : undefined, "unsubscribed")
      host.store.create("after-cleanup-key")
      expect(host.store.resolved).toHaveLength(1)
    })

    it("imports nothing when the startup listing fails, and keeps rotation", async () => {
      pool("key-a")
      const host = fakeV2Context({ connected: true })
      // The host decodes stored values while listing, so its errors can quote a key.
      host.store.getError = new Error("listing down: cannot decode sk-startup-secret")
      const log = logFrom()
      await setupV2(host.context)
      expect(host.hooks).toHaveLength(5)
      expect(log()).toContain("could not be listed at startup")
      expect(log()).not.toContain("sk-startup-secret")
      host.store.getError = undefined
      // Only the session-end watcher subscribed.
      expect(host.subscriptions).toHaveLength(1)
      host.store.create("unseen-key")
      expect(host.store.resolved).toEqual([])
    })
  })
})

describe("OpenCode V2 SDK event adapter", () => {
  // The importer lists credentials right after requesting the subscription, so a
  // credential created after that listing must reach the subscription. The host
  // side here is modeled on core v2.0.28 Bus.subscribe: a live PubSub stream.
  it("subscribes to the host stream during the first read, before it settles", async () => {
    const adapterPath = Bun.resolveSync("@opencode/plugin/promise/adapter", import.meta.dir)
    const { fromPromise } = await import(adapterPath)
    // The adapter's own Effect copy, so the host stream runs on the same runtime.
    const { Effect, Exit, PubSub, Scope, Stream } = await import(Bun.resolveSync("effect", dirname(adapterPath)))
    const pubsub = Effect.runSync(PubSub.unbounded())
    const delivered: unknown[] = []
    const subscribe = () => Stream.unwrap(Effect.sync(() => Stream.fromPubSub(pubsub))).pipe(
      Stream.filter(() => true),
      Stream.tap((event: unknown) => Effect.sync(() => { delivered.push(event) })),
    )
    // Every host member the adapter reads at setup, as inert stubs.
    const stub = (path: string): any => new Proxy(() => {}, {
      get: (_target, key) => {
        if (typeof key === "symbol") return undefined
        return path === "" && key === "event" ? { subscribe } : stub(`${path}.${key}`)
      },
      apply: () => Effect.void,
    })
    let ctx: any
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(fromPromise({ id: "order-probe", setup: async (context: unknown) => { ctx = context } }).effect(stub("")).pipe(Scope.provide(scope)))
    try {
      const controller = new AbortController()
      const iterator = ctx.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
      // In this install the adapter's encoding of a valid event fails with "s.startsWith is not
      // a function" inside the OpenCodeEvent schema, so the read never yields it. This test
      // therefore checks only that the host subscription exists before the first read settles.
      const first = iterator.next().then(() => {}, () => {})
      // A credential.updated envelope as core v2.0.28 publishes it, sent synchronously after
      // the first read was requested, with no await in between.
      const event = { id: "evt_probe", created: 1_760_000_000_000, type: "credential.updated", data: {} }
      Effect.runSync(PubSub.publish(pubsub, event))
      await until(() => delivered.length > 0 ? true : undefined, "delivery")
      expect(delivered).toEqual([event])
      controller.abort()
      await first
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
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
