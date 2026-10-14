import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin as V2TuiPlugin } from "@opencode/plugin/tui"
import { addAccount, listAccounts, removeAccount, setAccountRole, type AccountSummary } from "./accounts.js"
import { log } from "./logger.js"
import { GoAccountsRpc } from "./rpc.js"
import {
  errorMessage,
  GO_ACCOUNTS_COMMAND,
  GO_ACCOUNTS_DESCRIPTION,
  runAccountsFlow,
  runUsageFlow,
  type AccountBackend,
  type Activation,
  type Dialogs,
} from "./tui-flows.js"
import { collectStoredAccountUsage, GO_USAGE_COMMAND, GO_USAGE_DESCRIPTION, type AccountUsageRow } from "./usage.js"

const PROVIDER_ID = "opencode-go"
const PLUGIN_ID = "oc-go-multi-auth"

function redact(message: string, secret: string) {
  return message.split(secret).join("[redacted]")
}

function runDetached(name: string, flow: () => Promise<void>, onError: () => void) {
  void flow().catch((error) => {
    log("error", `${name} failed`, { error: errorMessage(error) })
    onError()
  })
}

// OpenCode 1: native callback dialogs adapted to promises. Values resolve
// synchronously from the host callback; the next dialog renders on the next
// turn because the host clears the closing dialog after its callback returns.
function v1Dialogs(api: TuiPluginApi): Dialogs {
  const show = (render: () => ReturnType<TuiPluginApi["ui"]["DialogAlert"]>, onClose: () => void, wide?: boolean) =>
    new Promise<void>((resolve, reject) => setTimeout(() => {
      try {
        api.ui.dialog.replace(render, onClose)
        // The host resets the size during replace.
        api.ui.dialog.setSize(wide ? "xlarge" : "medium")
        resolve()
      } catch (error) {
        reject(error)
      }
    }, 0))
  const settle = <Value>() => {
    let resolve!: (value: Value) => void
    let settled = false
    const promise = new Promise<Value>((done) => { resolve = done })
    return {
      promise,
      done(value: Value) {
        if (settled) return
        settled = true
        resolve(value)
      },
    }
  }
  return {
    async select(input) {
      const result = settle<typeof input.current | undefined>()
      await show(() => api.ui.DialogSelect({
        title: input.title,
        placeholder: input.placeholder,
        current: input.current,
        options: input.options.map((option) => ({ ...option })),
        onSelect: (option) => result.done(option.value),
      }), () => result.done(undefined), input.wide)
      return result.promise
    },
    async prompt(input) {
      const result = settle<string | undefined>()
      await show(() => api.ui.DialogPrompt({
        title: input.title,
        placeholder: input.placeholder,
        onConfirm: (value) => result.done(value),
        onCancel: () => result.done(undefined),
      }), () => result.done(undefined))
      return result.promise
    },
    async confirm(input) {
      const result = settle<boolean>()
      await show(() => api.ui.DialogConfirm({
        title: input.title,
        message: input.message,
        onConfirm: () => result.done(true),
        onCancel: () => result.done(false),
      }), () => result.done(false))
      return result.promise
    },
    async alert(input) {
      const result = settle<void>()
      await show(() => api.ui.DialogAlert({
        title: input.title,
        message: input.message,
        onConfirm: () => result.done(),
      }), () => result.done(), input.wide)
      return result.promise
    },
    toast: (input) => api.ui.toast(input),
  }
}

async function storeKeyV1(api: TuiPluginApi, key: string): Promise<Activation> {
  try {
    const result = await api.client.auth.set({ providerID: PROVIDER_ID, auth: { type: "api", key } })
    if (result.error !== undefined) throw result.error
    return { status: "activated" }
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : JSON.stringify(error), key)
    log("warn", "integration activation failed", { error: message })
    return { status: "failed", message }
  }
}

/**
 * OpenCode 1: stores the new key as the host's own opencode-go credential unless
 * one is already stored. The auth loader runs only for a stored key. The public
 * provider list reports where the active connection comes from, but an
 * environment or configuration connection can sit on top of a stored key, which
 * it cannot show; overwriting that key is left to the user's explicit choice.
 */
async function activateV1(api: TuiPluginApi, key: string): Promise<Activation> {
  try {
    const providers = await api.client.provider.list()
    if (providers.error !== undefined) throw providers.error
    if (providers.data?.connected.includes(PROVIDER_ID)) {
      const source = providers.data.all.find((provider) => provider.id === PROVIDER_ID)?.source
      return source === "api" ? { status: "already_connected" } : { status: "needs_choice" }
    }
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : JSON.stringify(error), key)
    log("warn", "integration activation failed", { error: message })
    return { status: "failed", message }
  }
  return storeKeyV1(api, key)
}

function v1Backend(api: TuiPluginApi): AccountBackend {
  return {
    list: async () => listAccounts(),
    async add(input) {
      const { account } = await addAccount(input)
      return { account, activation: await activateV1(api, input.apiKey) }
    },
    connect: (apiKey) => storeKeyV1(api, apiKey),
    setRole: (id, role) => setAccountRole({ id }, role),
    remove: (id) => removeAccount({ id }),
    usage: () => collectStoredAccountUsage(),
  }
}

const tui: TuiPlugin = async (api) => {
  const dialogs = v1Dialogs(api)
  const backend = v1Backend(api)
  const usageFailed = () => api.ui.toast({ variant: "error", message: "Failed to load OpenCode Go usage." })
  api.keymap.registerLayer({
    commands: [
      {
        name: GO_USAGE_COMMAND,
        title: GO_USAGE_DESCRIPTION,
        desc: GO_USAGE_DESCRIPTION,
        category: "OpenCode Go",
        namespace: "palette",
        slashName: GO_USAGE_COMMAND,
        run() {
          runDetached("usage report", () => runUsageFlow(dialogs, backend), usageFailed)
        },
      },
      {
        name: GO_ACCOUNTS_COMMAND,
        title: GO_ACCOUNTS_DESCRIPTION,
        desc: GO_ACCOUNTS_DESCRIPTION,
        category: "OpenCode Go",
        namespace: "palette",
        slashName: GO_ACCOUNTS_COMMAND,
        run() {
          runDetached("account management", () => runAccountsFlow(dialogs, backend), () => {})
        },
      },
    ],
  })
}

// OpenCode 2: promise dialogs and the plugin's RPC on the connected server,
// which may be remote.
function v2Dialogs(context: V2TuiPlugin.Context): Dialogs {
  const widen = (wide?: boolean) => {
    if (wide) context.ui.dialog.set({ size: "xlarge" })
  }
  return {
    select(input) {
      const pending = context.ui.dialog.select({
        title: input.title,
        placeholder: input.placeholder,
        current: input.current,
        options: input.options,
      })
      widen(input.wide)
      return pending
    },
    prompt: (input) => context.ui.dialog.prompt(input),
    async confirm(input) {
      return (await context.ui.dialog.confirm(input)) === true
    },
    alert(input) {
      const pending = context.ui.dialog.alert({ title: input.title, message: input.message })
      widen(input.wide)
      return pending
    },
    toast: (input) => context.ui.toast.show(input),
  }
}

function v2Backend(context: V2TuiPlugin.Context): AccountBackend {
  const rpc = context.client.rpc(GoAccountsRpc)
  const options = context.location ? { location: { directory: context.location.directory } } : undefined
  return {
    async list() {
      return ((await rpc.list({}, options)) as { accounts: AccountSummary[] }).accounts
    },
    async add(input) {
      return (await rpc.add(input, options)) as { account: AccountSummary; activation: Activation }
    },
    async setRole(id, role) {
      return ((await rpc.setRole({ id, role }, options)) as { account: AccountSummary }).account
    },
    async remove(id) {
      return ((await rpc.remove({ id }, options)) as { account: AccountSummary }).account
    },
    async usage() {
      return ((await rpc.usage({}, options)) as { rows: AccountUsageRow[] }).rows
    },
  }
}

function setup(context: V2TuiPlugin.Context) {
  const dialogs = v2Dialogs(context)
  const backend = v2Backend(context)
  const usageFailed = () => context.ui.toast.show({ variant: "error", message: "Failed to load OpenCode Go usage." })
  // Layers default to the base input mode, which hides them where the prompt runs; global opts out.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: `${PLUGIN_ID}.usage`,
        title: GO_USAGE_DESCRIPTION,
        group: "OpenCode Go",
        palette: true,
        slash: { name: GO_USAGE_COMMAND },
        run() {
          runDetached("usage report", () => runUsageFlow(dialogs, backend), usageFailed)
        },
      },
      {
        id: `${PLUGIN_ID}.accounts`,
        title: GO_ACCOUNTS_DESCRIPTION,
        group: "OpenCode Go",
        palette: true,
        slash: { name: GO_ACCOUNTS_COMMAND },
        run() {
          runDetached("account management", () => runAccountsFlow(dialogs, backend), () => {})
        },
      },
    ],
  }))
}

// One module serves both hosts: OpenCode 1 calls tui(), OpenCode 2 calls setup().
export default {
  id: PLUGIN_ID,
  tui,
  setup,
}
