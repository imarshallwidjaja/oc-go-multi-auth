import type { Plugin } from "@opencode-ai/plugin"
import { loadAccounts, saveAccounts, loadRotationState, saveRotationState } from "./storage"
import { selectAccount, hasAccounts } from "./rotate"
import { createRotatingFetch } from "./fetch"
import { log } from "./logger"
import { parseAccountRole, type AccountRole } from "./types"

function parseOptionalRole(value: unknown): AccountRole | null {
  if (value == null) return "primary"
  if (typeof value === "string" && value.trim() === "") return "primary"
  return parseAccountRole(value)
}

const plugin: Plugin = async ({ client }) => {
  const authClient = client as any

  return {
    auth: {
      provider: "opencode-go",
      async loader(getAuth) {
        const data = loadAccounts()
        const state = loadRotationState()

        if (!hasAccounts(data.accounts)) {
          log("warn", "loader skipped", { reason: "no enabled accounts" })
          return {}
        }

        const { account, index } = selectAccount(data.accounts, state.lastUsedIndex)
        data.rotationIndex = index
        saveAccounts(data)
        saveRotationState({ lastUsedIndex: index })

        await authClient.auth.set({
          path: { id: "opencode-go" },
          body: { type: "api", key: account.apiKey },
        })

        const { fetch } = createRotatingFetch(data.accounts, state.lastUsedIndex, undefined, {
          onStickyChange(account) {
            const current = loadAccounts()
            const currentIndex = current.accounts.findIndex(
              (candidate) => candidate.apiKey === account.apiKey && candidate.addedAt === account.addedAt,
            )
            if (currentIndex === -1) {
              log("warn", "sticky account persistence skipped", { reason: "account_removed" })
              return
            }
            current.rotationIndex = currentIndex
            saveAccounts(current)
            saveRotationState({ lastUsedIndex: currentIndex })
          },
        })

        log("info", "loader active", {
          account: account.label || `account-${index}`,
          role: account.role,
          index,
          total: data.accounts.length,
        })

        return {
          apiKey: "",
          fetch,
        }
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

            await authClient.auth.set({
              path: { id: "opencode-go" },
              body: { type: "api", key },
            })

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

export default plugin
