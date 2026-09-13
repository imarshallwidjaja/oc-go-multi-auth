#!/usr/bin/env bun
import { Command } from "commander"
import { readFileSync } from "fs"
import { loadAccounts, saveAccounts, loadRotationState } from "./storage.js"
import { hasAccounts } from "./rotate.js"
import { log } from "./logger.js"
import { parseAccountRole } from "./types.js"

const program = new Command()
const packageVersion = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string }).version

program.name("oc-go-multi-auth").description("Manage OpenCode Go multi-account auth").version(packageVersion)

program
  .command("list")
  .description("Show all configured Go accounts")
  .action(() => {
    const data = loadAccounts()
    if (data.accounts.length === 0) {
      console.log("No Go accounts configured.")
      return
    }
    for (let i = 0; i < data.accounts.length; i++) {
      const a = data.accounts[i]
      const label = a.label || `Account ${i + 1}`
      const status = a.enabled ? "enabled" : "disabled"
      const mark = i === data.rotationIndex ? " ← current" : ""
      console.log(`  ${i + 1}. ${label} [${status}] [${a.role}]${mark}`)
    }
    log("info", "list", { count: data.accounts.length })
  })

program
  .command("add")
  .description("Add a new Go account")
  .option("-k, --key <key>", "Go API key")
  .option("-l, --label <label>", "Account label")
  .option("-r, --role <role>", "Account role: primary or overage_fallback", "primary")
  .action((opts) => {
    if (!opts.key) {
      console.error("Error: --key is required")
      process.exit(1)
    }
    const role = parseAccountRole(opts.role)
    if (!role) {
      console.error('Error: --role must be "primary" or "overage_fallback"')
      process.exit(1)
    }
    const data = loadAccounts()
    data.accounts.push({
      apiKey: opts.key.trim(),
      label: opts.label?.trim() || undefined,
      addedAt: Date.now(),
      enabled: true,
      role,
    })
    if (data.accounts.length === 1) data.rotationIndex = 0
    saveAccounts(data)
    const label = opts.label?.trim() || `Account ${data.accounts.length}`
    console.log(`Added: ${label} [${role}]`)
    log("info", "add", { label, role, count: data.accounts.length })
  })

program
  .command("set-role")
  .description("Set the role of an account by number (1-based)")
  .argument("<number>", "Account number")
  .argument("<role>", "primary or overage_fallback")
  .action((numStr, roleStr) => {
    const role = parseAccountRole(roleStr)
    if (!role) {
      console.error('Error: role must be "primary" or "overage_fallback"')
      process.exit(1)
    }
    const num = Number.parseInt(numStr, 10) - 1
    const data = loadAccounts()
    if (Number.isNaN(num) || num < 0 || num >= data.accounts.length) {
      console.error(`Error: invalid account number "${numStr}". Choose 1-${data.accounts.length || 0}`)
      process.exit(1)
    }
    data.accounts[num].role = role
    saveAccounts(data)
    const label = data.accounts[num].label || `Account ${num + 1}`
    console.log(`Updated: ${label} → [${role}]`)
    log("info", "set-role", { label, role, index: num })
  })

program
  .command("remove")
  .description("Remove an account by number (1-based)")
  .argument("<number>", "Account number to remove")
  .action((numStr) => {
    const num = Number.parseInt(numStr, 10) - 1
    const data = loadAccounts()
    if (Number.isNaN(num) || num < 0 || num >= data.accounts.length) {
      console.error(`Error: invalid account number "${numStr}". Choose 1-${data.accounts.length}`)
      process.exit(1)
    }
    const removed = data.accounts.splice(num, 1)[0]
    if (data.rotationIndex >= data.accounts.length) {
      data.rotationIndex = Math.max(0, data.accounts.length - 1)
    }
    saveAccounts(data)
    const label = removed.label || `Account ${num + 1}`
    console.log(`Removed: ${label}`)
    log("info", "remove", { label })
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
    const primaries = data.accounts.filter((a) => a.enabled && a.role === "primary").length
    const overages = data.accounts.filter((a) => a.enabled && a.role === "overage_fallback").length
    console.log(`Accounts: ${data.accounts.length}`)
    console.log(`Primaries: ${primaries}`)
    console.log(`Overage fallbacks: ${overages}`)
    console.log(`Rotation: ${data.rotationIndex + 1} of ${data.accounts.length}`)
    console.log(`Last used index: ${state.lastUsedIndex}`)
    log("info", "status", {
      count: data.accounts.length,
      primaries,
      overages,
      rotationIndex: data.rotationIndex,
    })
  })

program.parse()
