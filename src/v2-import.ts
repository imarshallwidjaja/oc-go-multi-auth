// OpenCode 2: adds Go API keys connected through the host's own provider
// dialogs to the account file, so the next server start rotates with them.
import type { Plugin } from "@opencode/plugin"
import { AccountInputError, importAccount } from "./accounts.js"
import { log } from "./logger.js"
import { AccountsBusyError, AccountsCorruptError, accountsPath } from "./storage.js"

type Context = Plugin.Context
type Connection = Awaited<ReturnType<Context["integration"]["get"]>>["data"]["connections"][number]
type CredentialConnection = Extract<Connection, { type: "credential" }>

/** Messages of these errors name only paths and reasons; anything else is logged by name. */
function safeError(error: unknown) {
  if (error instanceof AccountInputError || error instanceof AccountsBusyError || error instanceof AccountsCorruptError) {
    return error.message
  }
  return error instanceof Error ? error.name : typeof error
}

/**
 * What the watchers of one account file in this process have done with each
 * credential. Each watcher keeps its own startup baseline, but a credential
 * one of them imported, found already pooled, or found gone is settled for all
 * of them. Otherwise an instance that refused a key while another imported it
 * could add the account again after the user removed it. A claim is the import
 * in progress, so no two watchers import one credential at once. Kept in
 * memory only, and dropped when the last watcher of the file stops.
 */
type ImportHistory = { settled: Set<string>; claims: Map<string, Promise<void>>; watchers: number }
const histories = new Map<string, ImportHistory>()

function acquireHistory() {
  const path = accountsPath()
  let history = histories.get(path)
  if (!history) {
    history = { settled: new Set(), claims: new Map(), watchers: 0 }
    histories.set(path, history)
  }
  history.watchers++
  const entry = history
  return {
    history: entry,
    release() {
      if (--entry.watchers === 0 && histories.get(path) === entry) histories.delete(path)
    },
  }
}

function isCredentialChange(event: unknown, integrationID: string) {
  const { type, data } = event as { type?: unknown; data?: { integrationID?: unknown } }
  // credential.updated carries no payload, so any update means a re-list.
  return type === "credential.updated" || (type === "credential.switched" && data?.integrationID === integrationID)
}

/**
 * Watches the host for Go API key credentials added after this call and
 * appends each new key to the account file as a primary account, unless an
 * account already holds it. Credentials listed when it starts are never
 * imported, and each credential is settled at most once among the watchers of
 * the account file, so activating or removing host credentials never re-adds
 * an account removed from the pool. The running pool keeps its startup
 * snapshot; imports apply after a restart.
 *
 * Changes are found by re-listing the integration on credential events, plus
 * one catch-up listing once the subscription has been requested. The host
 * offers no ready signal or cursor, so a change it never reports is not seen.
 *
 * Resolves to a stop function that ends the subscription, admits no new
 * import, and waits for an admitted one, so nothing writes after it resolves.
 */
export async function watchCredentialImports(
  ctx: Context,
  options: { integrationID: string; authorize: () => Promise<string | undefined> },
): Promise<() => Promise<void>> {
  const { integrationID, authorize } = options
  const stopNothing = async () => {}
  if (
    typeof ctx.event?.subscribe !== "function"
    || typeof ctx.integration?.get !== "function"
    || typeof ctx.integration?.connection?.resolve !== "function"
  ) {
    log("warn", "account import unavailable", { reason: "the host does not expose event, integration or connection lookups" })
    return stopNothing
  }

  const credentials = async () => {
    const { data } = await ctx.integration.get({ integrationID })
    return data.connections.filter((connection): connection is CredentialConnection => connection.type === "credential")
  }

  // Held before the first await: until this watcher stops, other watchers of the file
  // stopping must not drop the history of what they settled while its baseline is read.
  const { history, release } = acquireHistory()

  // Credential ids already considered, of every method. Never cleared.
  let known: Set<string>
  try {
    known = new Set((await credentials()).map((connection) => connection.id))
  } catch (error) {
    // Without a baseline every existing credential would look new; import nothing rather than all of them.
    release()
    log("warn", "account import unavailable", {
      reason: "OpenCode Go's connections could not be listed at startup",
      error: safeError(error),
    })
    return stopNothing
  }

  const lifetime = new AbortController()
  let stopped = false
  let queued = false
  let running: Promise<void> | undefined

  const consider = async (connection: CredentialConnection) => {
    // OAuth and external credentials hold no Go API key; resolving one could refresh it.
    if (connection.method !== "key") {
      known.add(connection.id)
      return
    }
    // Wait out another watcher's import of this credential, then claim it with no await in between.
    for (let claim = history.claims.get(connection.id); claim; claim = history.claims.get(connection.id)) await claim
    if (!history.settled.has(connection.id)) {
      if (stopped) return
      const claim = importCredential(connection).finally(() => history.claims.delete(connection.id))
      history.claims.set(connection.id, claim)
      await claim
    }
    if (history.settled.has(connection.id)) known.add(connection.id)
  }

  const importCredential = async (connection: CredentialConnection) => {
    // A provider bound to another integration must not have its keys read; the next event retries.
    if (await authorize() !== undefined || stopped) return
    let value: Awaited<ReturnType<Context["integration"]["connection"]["resolve"]>>
    try {
      value = await ctx.integration.connection.resolve(connection)
    } catch (error) {
      log("warn", "account import skipped", { reason: "a new OpenCode Go credential could not be read", error: safeError(error) })
      return
    }
    const apiKey = value?.type === "key" ? value.key.trim() : ""
    if (!apiKey) {
      // Removed meanwhile, or not a usable key.
      history.settled.add(connection.id)
      return
    }
    if (await authorize() !== undefined || stopped) return
    try {
      const result = await importAccount({ apiKey, label: connection.label })
      history.settled.add(connection.id)
      if (result.status === "imported") {
        log("info", "account imported", {
          label: result.account.label,
          count: result.count,
          action: "restart the OpenCode server to rotate with it",
        })
      } else {
        log("info", "account import skipped", { reason: "an account already holds this key" })
      }
    } catch (error) {
      if (error instanceof AccountsCorruptError) {
        // Each attempt would back the file up again; stop until the next start.
        stop()
        log("warn", "account import stopped", { error: error.message })
        return
      }
      log("warn", "account import failed", { error: safeError(error) })
    }
  }

  const reconcile = async () => {
    let listed: CredentialConnection[]
    try {
      listed = await credentials()
    } catch (error) {
      log("warn", "account import skipped", {
        reason: "OpenCode Go's connections could not be listed",
        error: safeError(error),
      })
      return
    }
    // Connections carry no creation time and the host's listing order is not chronological,
    // so imported accounts follow the reversed listing order, not necessarily creation order.
    for (const connection of listed.filter((candidate) => !known.has(candidate.id)).reverse()) {
      if (stopped) return
      await consider(connection)
    }
  }

  // One reconcile at a time; requests during a run coalesce into one more run.
  const drain = async () => {
    try {
      while (queued && !stopped) {
        queued = false
        await reconcile()
      }
    } finally {
      running = undefined
    }
  }
  const request = () => {
    if (stopped) return
    queued = true
    running ??= drain()
  }
  function stop() {
    stopped = true
    lifetime.abort()
  }

  const signal = lifetime.signal
  void (async () => {
    try {
      // Requests the subscription synchronously, before the catch-up listing below.
      for await (const event of ctx.event.subscribe({ signal })) {
        if (isCredentialChange(event, integrationID)) request()
      }
    } catch (error) {
      if (!signal.aborted) {
        log("warn", "account import stopped", {
          reason: "the event stream failed",
          error: safeError(error),
        })
      }
    }
  })()
  request()

  let released = false
  return async () => {
    stop()
    await running
    if (released) return
    released = true
    release()
  }
}
