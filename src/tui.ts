import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import {
  collectStoredAccountUsage,
  EMPTY_USAGE_MESSAGE,
  formatAccountRow,
  formatAggregateUsage,
  GO_USAGE_COMMAND,
  GO_USAGE_DESCRIPTION,
} from "./usage.js"
import { log } from "./logger.js"

const LOADING_TOAST_DURATION_MS = 2_000

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: GO_USAGE_COMMAND,
        title: GO_USAGE_DESCRIPTION,
        desc: GO_USAGE_DESCRIPTION,
        category: "OpenCode Go",
        namespace: "palette",
        slashName: GO_USAGE_COMMAND,
        async run() {
          api.ui.toast({
            variant: "info",
            message: "Loading OpenCode Go usage...",
            duration: LOADING_TOAST_DURATION_MS,
          })
          try {
            const rows = await collectStoredAccountUsage()
            if (rows.length === 0) {
              api.ui.dialog.replace(() => api.ui.DialogAlert({
                title: "OpenCode Go usage - Esc close",
                message: EMPTY_USAGE_MESSAGE,
              }))
              api.ui.dialog.setSize("xlarge")
              return
            }
            const aggregate = formatAggregateUsage(rows)
            const details = new Map<string, string>()
            details.set(aggregate.value, aggregate.message)
            const options = [
              { title: aggregate.title, value: aggregate.value },
              ...rows.map((row) => {
                const formatted = formatAccountRow(row)
                const newline = formatted.indexOf("\n")
                const value = String(row.index)
                details.set(value, newline === -1 ? formatted : formatted.slice(newline + 1))
                return {
                  title: newline === -1 ? formatted : formatted.slice(0, newline),
                  value,
                }
              }),
            ]
            const showAccounts = () => {
              api.ui.dialog.replace(() => api.ui.DialogSelect({
                title: "OpenCode Go usage - Up/Down, PgUp/PgDn, Home/End; Enter details; Esc close",
                placeholder: "Filter accounts",
                options,
                onSelect(option) {
                  const message = details.get(option.value)
                  if (message === undefined) throw new Error(`Missing usage details for account ${option.value}`)
                  api.ui.dialog.replace(() => api.ui.DialogAlert({
                    title: `${option.title} - Enter back; Esc close`,
                    message: option.value === aggregate.value ? message : message.trim(),
                    // The host clears the alert after onConfirm, so reopen the list on the next turn.
                    onConfirm: () => setTimeout(showAccounts, 0),
                  }))
                  api.ui.dialog.setSize("xlarge")
                },
              }))
              api.ui.dialog.setSize("xlarge")
            }
            showAccounts()
          } catch (error) {
            log("error", "usage report failed", {
              error: error instanceof Error ? error.message : String(error),
            })
            api.ui.toast({
              variant: "error",
              message: "Failed to load OpenCode Go usage.",
            })
          }
        },
      },
    ],
  })
}

export default {
  id: "oc-go-multi-auth",
  tui,
  // OpenCode 2.0.2 discovers package ./tui exports independently. Its server
  // command remains authoritative, so the V2 TUI activation is intentionally empty.
  async setup() {},
}
