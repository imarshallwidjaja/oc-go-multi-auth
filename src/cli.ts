#!/usr/bin/env bun
import { Command } from "commander"
import { readFileSync } from "fs"
import { addAccount, listAccounts, removeAccount, setAccountRole } from "./accounts.js"
import { log } from "./logger.js"
import { hasAccounts } from "./rotate.js"
import { loadAccounts, loadRotationState, resolveLastUsedIndex } from "./storage.js"
import { GO_USAGE_DESCRIPTION, reportGoUsage } from "./usage.js"

const RESTART_NOTE = "Saved. Running OpenCode sessions keep their current account list until OpenCode restarts."

const program = new Command()
const packageVersion = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string }).version

program.name("oc-go-multi-auth").description("Manage OpenCode Go multi-account auth").version(packageVersion)

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

program
  .command("list")
  .description("Show all configured Go accounts")
  .action(() => {
    const accounts = listAccounts()
    if (accounts.length === 0) {
      console.log("No Go accounts configured.")
      return
    }
    for (const account of accounts) {
      const status = account.enabled ? "enabled" : "disabled"
      const mark = account.lastUsed ? " ← last used" : ""
      console.log(`  ${account.number}. ${account.label} [${status}] [${account.role}]${mark}`)
    }
    log("info", "list", { count: accounts.length })
  })

program
  .command("add")
  .description("Add a new Go account")
  .option("-k, --key <key>", "Go API key")
  .option("-l, --label <label>", "Account label")
  .option("-r, --role <role>", "Account role: primary or overage_fallback", "primary")
  .action(async (opts) => {
    if (!opts.key) fail("--key is required")
    try {
      const { account } = await addAccount({ apiKey: opts.key, label: opts.label, role: opts.role })
      console.log(`Added: ${account.label} [${account.role}]`)
      console.log(RESTART_NOTE)
    } catch (error) {
      fail(error)
    }
  })

program
  .command("set-role")
  .description("Set the role of an account by number (1-based)")
  .argument("<number>", "Account number")
  .argument("<role>", "primary or overage_fallback")
  .action(async (numStr: string, roleStr: string) => {
    try {
      const account = await setAccountRole({ number: Number.parseInt(numStr, 10), input: numStr }, roleStr)
      console.log(`Updated: ${account.label} → [${account.role}]`)
      console.log(RESTART_NOTE)
    } catch (error) {
      fail(error)
    }
  })

program
  .command("remove")
  .description("Remove an account by number (1-based)")
  .argument("<number>", "Account number to remove")
  .action(async (numStr: string) => {
    try {
      const account = await removeAccount({ number: Number.parseInt(numStr, 10), input: numStr })
      console.log(`Removed: ${account.label}`)
      console.log(RESTART_NOTE)
      console.log("The key stays in OpenCode's own credential store if it was connected there; remove it with OpenCode's provider settings.")
    } catch (error) {
      fail(error)
    }
  })

program
  .command("status")
  .description("Show rotation state and current account")
  .action(() => {
    const data = loadAccounts()
    const state = loadRotationState()
    if (!hasAccounts(data.accounts)) {
      console.log("No enabled accounts. Plugin inactive.")
      return
    }
    const lastUsedIndex = resolveLastUsedIndex(data.accounts, state)
    const primaries = data.accounts.filter((a) => a.enabled && a.role === "primary").length
    const overages = data.accounts.filter((a) => a.enabled && a.role === "overage_fallback").length
    console.log(`Accounts: ${data.accounts.length}`)
    console.log(`Primaries: ${primaries}`)
    console.log(`Overage fallbacks: ${overages}`)
    console.log(lastUsedIndex === -1
      ? "Last used: none recorded"
      : `Last used: ${lastUsedIndex + 1} of ${data.accounts.length}`)
    log("info", "status", {
      count: data.accounts.length,
      primaries,
      overages,
      lastUsedIndex,
    })
  })

program
  .command("usage")
  .description(GO_USAGE_DESCRIPTION)
  .action(async () => {
    try {
      console.log(await reportGoUsage())
    } catch (error) {
      fail(error)
    }
  })

await program.parseAsync(process.argv)
