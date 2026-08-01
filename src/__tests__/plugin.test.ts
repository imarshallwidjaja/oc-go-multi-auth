import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Plugin } from "@opencode-ai/plugin"
import { loadAccounts, loadRotationState, saveAccounts, saveRotationState } from "../storage"

const originalHome = process.env.HOME
let tmpHome: string
let plugin: Plugin

function pluginInput(client: unknown): Parameters<Plugin>[0] {
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

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "go-plugin-test-"))
  process.env.HOME = tmpHome
  plugin = (await import("../index")).default
})

beforeEach(() => {
  saveAccounts({ version: 1, accounts: [], rotationIndex: 0 })
  saveRotationState({ lastUsedIndex: -1 })
})

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("plugin auth hook contract", () => {
  it("exports the opencode-go auth hook and stores credentials under that provider", async () => {
    expect(typeof plugin).toBe("function")
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
        },
      },
    }
    const hooks = await plugin(pluginInput(client))

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
    const client = { auth: { set: async () => {} } }
    const hooks = await plugin(pluginInput(client))
    const add = hooks.auth!.methods.find((candidate) => candidate.label === "Add Go Account")!
    const setRole = hooks.auth!.methods.find((candidate) => candidate.label === "Set Go Account Role")!

    await add.authorize({ apiKey: "key-a", label: "alpha", role: "primary" })
    await add.authorize({ apiKey: "key-b", label: "beta", role: "overage_fallback" })
    expect(loadAccounts().accounts.map((a) => a.role)).toEqual(["primary", "overage_fallback"])

    const result = await setRole.authorize({ account: "2", role: "primary" })
    expect(result).toEqual({ type: "success", key: "key-a" })
    expect(loadAccounts().accounts[1].role).toBe("primary")
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
      const client = { auth: { set: async () => {} } }
      const hooks = await plugin(pluginInput(client))
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
      const client = { auth: { set: async () => {} } }
      const hooks = await plugin(pluginInput(client))
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
      const client = { auth: { set: async () => {} } }
      const hooks = await plugin(pluginInput(client))
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
})
