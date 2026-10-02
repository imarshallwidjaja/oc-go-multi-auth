import type { Plugin as V2Plugin } from "@opencode/plugin"
import type { Hooks, Plugin as V1Plugin } from "@opencode-ai/plugin"
import { loadAccounts, saveAccounts } from "./storage.js"
import { log } from "./logger.js"
import { NATIVE_PACKAGE_SETTING, V2_NATIVE_PACKAGE_IDS } from "./opencode.js"
import { parseAccountRole, type AccountRole } from "./types.js"
import { initializeRotation } from "./runtime.js"
import {
  GO_USAGE_COMMAND,
  GO_USAGE_DESCRIPTION,
  reportGoUsage,
} from "./usage.js"

const PROVIDER_ID = "opencode-go"
const V2_PROVIDER_PACKAGE = "oc-go-multi-auth/v2/provider"
const V2_NATIVE_PACKAGES = new Set<string>(V2_NATIVE_PACKAGE_IDS)

type CatalogPackage = {
  package?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeBody(
  base: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(Array.from(new Set([...Object.keys(base), ...Object.keys(overlay)]), (key) => {
    const left = base[key]
    const right = overlay[key]
    if (right === undefined) return [key, left]
    if (isRecord(left) && isRecord(right)) return [key, mergeBody(left, right)]
    return [key, right]
  }))
}

function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>> | undefined,
) {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(
    [...Object.entries(base), ...Object.entries(overlay)]
      .reduce((result, entry) => result.set(entry[0].toLowerCase(), entry), new Map<string, [string, string]>())
      .values(),
  )
}

function normalizeV2Package(entry: CatalogPackage, providerID: string, inheritedPackage?: string) {
  const source = entry.package ?? inheritedPackage
  if (source === V2_PROVIDER_PACKAGE) {
    return V2_NATIVE_PACKAGES.has(String(entry.settings?.[NATIVE_PACKAGE_SETTING]))
  }
  if (!source || !V2_NATIVE_PACKAGES.has(source)) return false

  // Mirrors the three relevant mappings in OpenCode 2.0.2 AISDKNative.map.
  const settings = { ...entry.settings }
  const legacyHeaders = isRecord(settings.headers)
    && Object.values(settings.headers).every((value) => typeof value === "string")
    ? settings.headers as Record<string, string>
    : undefined
  const extraBody = isRecord(settings.extraBody) ? settings.extraBody : undefined
  if (settings.apiKey !== undefined && typeof settings.apiKey !== "string") delete settings.apiKey
  if (settings.baseURL !== undefined && typeof settings.baseURL !== "string") delete settings.baseURL
  delete settings.headers
  delete settings.extraBody
  delete settings.useCompletionUrls
  if (source === "aisdk:@ai-sdk/openai-compatible") settings.provider = providerID
  settings[NATIVE_PACKAGE_SETTING] = source

  entry.settings = settings
  entry.headers = mergeHeaders(legacyHeaders, entry.headers)
  entry.body = mergeBody(extraBody, entry.body)
  entry.package = V2_PROVIDER_PACKAGE
  return true
}

function parseOptionalRole(value: unknown): AccountRole | null {
  if (value == null) return "primary"
  if (typeof value === "string" && value.trim() === "") return "primary"
  return parseAccountRole(value)
}

function createV1Hooks(setAuth: (key: string) => Promise<void>): Hooks {
  return {
    auth: {
      provider: PROVIDER_ID,
      async loader() {
        const options = initializeRotation()
        if (!options) return {}
        await setAuth(options.key)
        return { apiKey: "", fetch: options.fetch }
      },
      methods: [
        {
          type: "api",
          label: "Add Go Account",
          prompts: [
            { type: "text", key: "apiKey", message: "Go API key from opencode.ai/auth" },
            { type: "text", key: "label", message: "Label for this account (optional)" },
            {
              type: "text",
              key: "role",
              message: 'Role: "primary" (default) or "overage_fallback"',
            },
          ],
          async authorize(inputs) {
            const key = inputs?.apiKey?.trim()
            if (!key) return { type: "failed" }

            const role = parseOptionalRole(inputs?.role)
            if (!role) return { type: "failed" }

            const data = loadAccounts()
            const label = inputs?.label?.trim() || undefined
            data.accounts.push({
              apiKey: key,
              label,
              addedAt: Date.now(),
              enabled: true,
              role,
            })

            if (data.accounts.length === 1) data.rotationIndex = 0
            saveAccounts(data)

            await setAuth(key)

            log("info", "account added via auth login", {
              label: label || `account-${data.accounts.length}`,
              role,
              count: data.accounts.length,
            })

            return { type: "success", key }
          },
        },
        {
          type: "api",
          label: "Set Go Account Role",
          prompts: [
            {
              type: "text",
              key: "account",
              message: "Account number from oc-go-multi-auth list (1-based)",
            },
            {
              type: "text",
              key: "role",
              message: 'Role: "primary" or "overage_fallback"',
            },
          ],
          async authorize(inputs) {
            const role = parseAccountRole(inputs?.role)
            if (!role) return { type: "failed" }

            const data = loadAccounts()
            const num = Number.parseInt(String(inputs?.account ?? "").trim(), 10) - 1
            if (Number.isNaN(num) || num < 0 || num >= data.accounts.length) {
              return { type: "failed" }
            }

            data.accounts[num].role = role
            saveAccounts(data)

            const label = data.accounts[num].label || `account-${num + 1}`
            log("info", "account role updated via auth login", {
              label,
              role,
              index: num,
            })

            // Return the persisted sticky key so OpenCode does not switch auth to the edited account.
            const stickyIndex = Math.min(
              Math.max(0, data.rotationIndex),
              data.accounts.length - 1,
            )
            return { type: "success", key: data.accounts[stickyIndex].apiKey }
          },
        },
      ],
    },
  }
}

const server: V1Plugin = async ({ client }) => {
  return createV1Hooks(async (key) => {
    const result = await client.auth.set({
      path: { id: PROVIDER_ID },
      body: { type: "api", key },
    })
    if (result.error !== undefined) {
      const detail = result.error instanceof Error ? result.error.message : JSON.stringify(result.error)
      throw new Error(`Failed to set OpenCode Go authentication: ${detail}`)
    }
  })
}

const v2Setups = new WeakMap<object, () => Promise<void>>()

const plugin = {
  id: "oc-go-multi-auth",
  async setup(ctx) {
    await v2Setups.get(ctx)?.()

    const integrationRegistration = await ctx.integration.transform((integration) => {
      integration.update(PROVIDER_ID, (value) => {
        value.name = "OpenCode Go"
      })
      integration.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "key", label: "Go API key" },
      })
    })

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: GO_USAGE_COMMAND,
        description: GO_USAGE_DESCRIPTION,
        execute: async ({ sessionID }) => {
          const text = await reportGoUsage()
          await ctx.session.synthetic({ sessionID, text })
        },
      })
    })

    const account = loadAccounts().accounts.find((candidate) => candidate.enabled)
    if (!account) {
      log("warn", "catalog rotation setup skipped", { reason: "no enabled accounts", action: "restart after adding an account" })
      let active = true
      const cleanup = async () => {
        if (!active) return
        active = false
        if (v2Setups.get(ctx) === cleanup) v2Setups.delete(ctx)
        await Promise.all([commandRegistration.dispose(), integrationRegistration.dispose()])
      }
      v2Setups.set(ctx, cleanup)
      return cleanup
    }

    const catalogRegistration = await ctx.catalog.transform((catalog) => {
      const record = catalog.provider.get(PROVIDER_ID)
      if (!record) return

      const providerPackage = record.provider.package
      const providerIdentity = String(record.provider.canonical ?? PROVIDER_ID)
      let wrapped = normalizeV2Package(record.provider, providerIdentity)

      for (const model of record.models.values()) {
        wrapped = normalizeV2Package(model, providerIdentity, providerPackage) || wrapped
      }
      if (wrapped) {
        record.provider.integrationID = PROVIDER_ID as unknown as NonNullable<typeof record.provider.integrationID>
      }
    })

    let active = true
    const cleanup = async () => {
      if (!active) return
      active = false
      if (v2Setups.get(ctx) === cleanup) v2Setups.delete(ctx)
      await Promise.all([
        catalogRegistration.dispose(),
        commandRegistration.dispose(),
        integrationRegistration.dispose(),
      ])
    }
    v2Setups.set(ctx, cleanup)

    try {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      if (!connection) {
        await ctx.integration.connect.key({ integrationID: PROVIDER_ID, key: account.apiKey })
      }
    } catch (error) {
      log("warn", "integration connection priming failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return cleanup
  },
} satisfies V2Plugin.Plugin

interface RootPlugin {
  readonly id: string
  readonly setup: (context: unknown) => Promise<() => Promise<void>>
  readonly server: (input: unknown) => Promise<unknown>
}

export default { ...plugin, server } as RootPlugin
