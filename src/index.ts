import type { Plugin } from "@opencode-ai/plugin"
import { loadAccounts, saveAccounts, loadRotationState, saveRotationState } from "./storage"
import { selectAccount, hasAccounts } from "./rotate"
import { createRotatingFetch } from "./fetch"
import { log } from "./logger"
import { parseAccountRole, type AccountRole } from "./types"
import { createHandoff, saveHandoff, type Message } from "./handoff"

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
          cooldownMs: 5 * 60 * 60 * 1000,  // 5 hours for OpenCode Go
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
          async onRateLimit(accountIndex: number, sessionId: string) {
            log("info", "creating handoff for rate limit", {
              accountIndex,
              sessionId,
            })

            // Get recent messages and modified files from the client
            // Note: In a real implementation, these would come from the OpenCode client
            const recentMessages: Message[] = []
            const modifiedFiles: string[] = []

            // Get compaction summary from opencode-live-compaction
            const compactionSummary = "Session context preserved through auto-handoff"

            try {
              const handoff = await createHandoff(
                compactionSummary,
                recentMessages,
                modifiedFiles,
                accountIndex,
                sessionId,
                {
                  languagetool: { mode: "local", localPort: 8010 },
                  caveman: { mode: "local" },
                },
              )

              saveHandoff(handoff)

              log("info", "handoff created successfully", {
                id: handoff.id,
                path: handoff.path,
                language: handoff.language,
                compressedSize: handoff.metadata.compressedSize,
                originalSize: handoff.metadata.originalSize,
              })

              // TODO: Trigger new session with next account
              // This would involve calling OpenCode's API to create a new session
              // and execute /handoff resume <path>
            } catch (error) {
              log("error", "handoff creation failed", {
                error: error instanceof Error ? error.message : String(error),
              })
            }
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
        {
          type: "api",
          label: "Force Handoff",
          prompts: [
            {
              type: "text",
              key: "message",
              message: "Reason for handoff (optional)",
            },
            {
              type: "text",
              key: "account",
              message: "Switch to specific account number (1-based, optional)",
            },
          ],
          async authorize(inputs) {
            const data = loadAccounts()
            const state = loadRotationState()

            if (!hasAccounts(data.accounts)) {
              log("warn", "force handoff failed", { reason: "no enabled accounts" })
              return { type: "failed" }
            }

            const currentIndex = data.rotationIndex
            const message = inputs?.message?.trim() || "Manual handoff triggered"

            // Create handoff
            const recentMessages = [
              { role: "user" as const, content: message },
              { role: "assistant" as const, content: "Handoff created manually" },
            ]

            try {
              const handoff = await createHandoff(
                message,
                recentMessages,
                [],
                currentIndex,
                `manual-${Date.now()}`,
              )

              saveHandoff(handoff)

              // Determine next account
              let nextIndex: number
              if (inputs?.account) {
                nextIndex = Number.parseInt(inputs.account, 10) - 1
                if (nextIndex < 0 || nextIndex >= data.accounts.length || !data.accounts[nextIndex].enabled) {
                  return { type: "failed" }
                }
              } else {
                nextIndex = (currentIndex + 1) % data.accounts.length
                while (nextIndex !== currentIndex && !data.accounts[nextIndex].enabled) {
                  nextIndex = (nextIndex + 1) % data.accounts.length
                }
                if (nextIndex === currentIndex) {
                  return { type: "failed" }
                }
              }

              // Update rotation
              data.rotationIndex = nextIndex
              saveAccounts(data)
              saveRotationState({ lastUsedIndex: nextIndex })

              const nextAccount = data.accounts[nextIndex]
              log("info", "force handoff", {
                fromIndex: currentIndex,
                toIndex: nextIndex,
                handoffId: handoff.id,
              })

              return { type: "success", key: nextAccount.apiKey }
            } catch (error) {
              log("error", "force handoff failed", {
                error: error instanceof Error ? error.message : String(error),
              })
              return { type: "failed" }
            }
          },
        },
      ],
    },
  }
}

export default plugin
