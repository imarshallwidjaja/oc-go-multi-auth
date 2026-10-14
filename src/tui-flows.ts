// Host-neutral /go-accounts and /go-usage flows. Each host supplies its native
// dialogs and an account backend: local files on OpenCode 1, RPC on OpenCode 2.
import type { AccountSummary } from "./accounts.js"
import type { AccountRole } from "./types.js"
import {
  EMPTY_USAGE_MESSAGE,
  formatAccountRow,
  formatAggregateUsage,
  type AccountUsageRow,
} from "./usage.js"

export interface SelectOption<Value> {
  title: string
  value: Value
  description?: string
}

export interface Dialogs {
  select<Value>(input: {
    title: string
    placeholder?: string
    options: SelectOption<Value>[]
    current?: Value
    wide?: boolean
  }): Promise<Value | undefined>
  prompt(input: { title: string; placeholder?: string }): Promise<string | undefined>
  confirm(input: { title: string; message: string }): Promise<boolean>
  alert(input: { title: string; message: string; wide?: boolean }): Promise<void>
  toast(input: { variant: "info" | "success" | "warning" | "error"; message: string; duration?: number }): void
}

export type Activation =
  | { status: "already_connected" }
  | { status: "activated" }
  /** The host serves OpenCode Go through something rotation cannot take over, such as a Console integration. */
  | { status: "unsupported"; message: string }
  /** OpenCode 1 only: an environment or configured connection may or may not sit on a stored key, and replacing it needs consent. */
  | { status: "needs_choice" }
  | { status: "failed"; message?: string }

export interface AccountBackend {
  list(): Promise<AccountSummary[]>
  add(input: { apiKey: string; label?: string; role: AccountRole }): Promise<{ account: AccountSummary; activation: Activation }>
  /** Stores the key as OpenCode's own connection. Offered only where add() can report needs_choice. */
  connect?(apiKey: string): Promise<Activation>
  setRole(id: string, role: AccountRole): Promise<AccountSummary>
  remove(id: string): Promise<AccountSummary>
  usage(): Promise<AccountUsageRow[]>
}

export const GO_ACCOUNTS_COMMAND = "go-accounts"
export const GO_ACCOUNTS_DESCRIPTION = "Add, remove, or change roles of OpenCode Go accounts"
export const RESTART_NOTE = "Restart OpenCode to use the updated account list."
const LOADING_TOAST_DURATION_MS = 2_000

/** Messages from the backend are display-safe; RPC failures arrive as plain { message } objects. */
export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  return String(error)
}

const ROLE_OPTIONS: SelectOption<AccountRole>[] = [
  { title: "primary", value: "primary", description: "Used first" },
  { title: "overage_fallback", value: "overage_fallback", description: "Used after every primary is unavailable" },
]

function accountTitle(account: AccountSummary) {
  const flags = [account.enabled ? "" : "disabled", account.lastUsed ? "last used" : ""].filter(Boolean)
  return `${account.number}. ${account.label}  [${account.role}]  key ${account.keyHint}${flags.length ? `  ${flags.join(", ")}` : ""}`
}

type AccountsChoice = { type: "add" } | { type: "account"; account: AccountSummary }

async function addFlow(dialogs: Dialogs, backend: AccountBackend) {
  const apiKey = (await dialogs.prompt({ title: "Go API key", placeholder: "Key from opencode.ai/auth" }))?.trim()
  if (!apiKey) return
  const label = await dialogs.prompt({ title: "Label (optional)", placeholder: "Work, Personal, ..." })
  if (label === undefined) return
  const role = await dialogs.select<AccountRole>({ title: "Role for the new account", options: ROLE_OPTIONS, current: "primary" })
  if (!role) return
  const added = await backend.add({ apiKey, label: label.trim() || undefined, role })
  const { account } = added
  let { activation } = added
  if (activation.status === "needs_choice" && backend.connect) {
    const choice = await dialogs.select<"connect" | "keep">({
      title: "OpenCode Go is already connected",
      options: [
        { title: "Connect pool account", value: "connect", description: "Stores this key in OpenCode, replacing any stored OpenCode Go key" },
        { title: "Keep current connection", value: "keep", description: "Leaves the connection unchanged; rotation needs a stored key and a restart" },
      ],
      current: "keep",
    })
    if (choice === "connect") activation = await backend.connect(apiKey)
  }
  const saved = `Saved ${account.label} [${account.role}]`
  if (activation.status === "failed") {
    dialogs.toast({
      variant: "warning",
      message: `${saved}, but connecting OpenCode Go failed${activation.message ? `: ${activation.message}` : ""}. ${RESTART_NOTE}`,
    })
    return
  }
  if (activation.status === "unsupported") {
    dialogs.toast({ variant: "warning", message: `${saved}, but account rotation is inactive: ${activation.message}` })
    return
  }
  if (activation.status === "needs_choice") {
    dialogs.toast({
      variant: "warning",
      message: `${saved}. OpenCode Go's connection was left unchanged; rotation needs a key stored in OpenCode. ${RESTART_NOTE}`,
    })
    return
  }
  const connected = activation.status === "activated" ? " OpenCode Go is now connected with this key." : ""
  dialogs.toast({ variant: "success", message: `${saved}.${connected} ${RESTART_NOTE}` })
}

async function accountFlow(dialogs: Dialogs, backend: AccountBackend, account: AccountSummary) {
  const otherRole: AccountRole = account.role === "primary" ? "overage_fallback" : "primary"
  const action = await dialogs.select<"role" | "remove">({
    title: `${account.number}. ${account.label} [${account.role}]`,
    options: [
      { title: `Change role to ${otherRole}`, value: "role" },
      { title: "Remove from the pool", value: "remove" },
    ],
  })
  if (action === "role") {
    const updated = await backend.setRole(account.id, otherRole)
    dialogs.toast({ variant: "success", message: `Updated ${updated.label} to [${updated.role}]. ${RESTART_NOTE}` })
  } else if (action === "remove") {
    const confirmed = await dialogs.confirm({
      title: `Remove ${account.label}?`,
      message: "This removes the account from the rotation pool only. A key connected to OpenCode itself stays connected; remove that in OpenCode's provider settings.",
    })
    if (!confirmed) return
    const removed = await backend.remove(account.id)
    dialogs.toast({ variant: "success", message: `Removed ${removed.label}. ${RESTART_NOTE}` })
  }
}

/** Runs until the user closes the account list. */
export async function runAccountsFlow(dialogs: Dialogs, backend: AccountBackend) {
  while (true) {
    let choice: AccountsChoice | undefined
    try {
      const accounts = await backend.list()
      choice = await dialogs.select<AccountsChoice>({
        title: "OpenCode Go accounts - Enter choose; Esc close",
        placeholder: "Filter accounts",
        wide: true,
        options: [
          { title: "Add account", value: { type: "add" } },
          ...accounts.map((account) => ({ title: accountTitle(account), value: { type: "account" as const, account } })),
        ],
      })
      if (!choice) return
      if (choice.type === "add") await addFlow(dialogs, backend)
      else await accountFlow(dialogs, backend, choice.account)
    } catch (error) {
      dialogs.toast({ variant: "error", message: errorMessage(error) })
      if (!choice) return
    }
  }
}

/** Shows the aggregate and per-account quota; Enter opens details and returns to the list. */
export async function runUsageFlow(dialogs: Dialogs, backend: AccountBackend) {
  dialogs.toast({ variant: "info", message: "Loading OpenCode Go usage...", duration: LOADING_TOAST_DURATION_MS })
  const rows = await backend.usage()
  if (rows.length === 0) {
    await dialogs.alert({ title: "OpenCode Go usage - Esc close", message: EMPTY_USAGE_MESSAGE, wide: true })
    return
  }
  const aggregate = formatAggregateUsage(rows)
  const details = new Map<string, string>([[aggregate.value, aggregate.message]])
  const options: SelectOption<string>[] = [
    { title: aggregate.title, value: aggregate.value },
    ...rows.map((row) => {
      const formatted = formatAccountRow(row)
      const newline = formatted.indexOf("\n")
      const value = String(row.index)
      details.set(value, newline === -1 ? formatted : formatted.slice(newline + 1).trim())
      return { title: newline === -1 ? formatted : formatted.slice(0, newline), value }
    }),
  ]
  while (true) {
    const value = await dialogs.select({
      title: "OpenCode Go usage - Up/Down, PgUp/PgDn, Home/End; Enter details; Esc close",
      placeholder: "Filter accounts",
      options,
      wide: true,
    })
    if (value === undefined) return
    const option = options.find((candidate) => candidate.value === value)
    const message = details.get(value)
    if (!option || message === undefined) throw new Error(`Missing usage details for account ${value}`)
    await dialogs.alert({ title: `${option.title} - Enter back`, message, wide: true })
  }
}
