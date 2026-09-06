#!/usr/bin/env bun
import { Command } from "commander"
import { loadAccounts, saveAccounts, loadRotationState, saveRotationState } from "./storage"
import { hasAccounts } from "./rotate"
import { log } from "./logger"
import { parseAccountRole } from "./types"
import { createHandoff, saveHandoff, listHandoffs, type Message } from "./handoff"

const program = new Command()

program.name("opencode-go-session-manager").description("Manage OpenCode Go session manager").version("0.1.0")

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

program
  .command("force-handoff")
  .description("Force a handoff and switch to next account")
  .option("-m, --message <message>", "Custom message for the handoff", "Manual handoff triggered")
  .option("-a, --account <number>", "Switch to specific account number (1-based)")
  .action(async (opts) => {
    const data = loadAccounts()
    const state = loadRotationState()

    if (!hasAccounts(data.accounts)) {
      console.error("Error: No enabled accounts configured")
      process.exit(1)
    }

    const currentIndex = data.rotationIndex
    const currentAccount = data.accounts[currentIndex]
    const label = currentAccount.label || `Account ${currentIndex + 1}`

    console.log(`Forcing handoff for ${label}...`)

    // Create a handoff with the custom message
    const recentMessages: Message[] = [
      { role: "user", content: opts.message },
      { role: "assistant", content: "Handoff created manually via CLI" },
    ]

    try {
      const handoff = await createHandoff(
        opts.message,
        recentMessages,
        [], // no modified files
        currentIndex,
        `manual-${Date.now()}`,
      )

      saveHandoff(handoff)

      console.log(`Handoff created: ${handoff.id}`)
      console.log(`Path: ${handoff.path}`)
      console.log(`Language: ${handoff.language}`)

      // Determine next account
      let nextIndex: number
      if (opts.account) {
        nextIndex = Number.parseInt(opts.account, 10) - 1
        if (nextIndex < 0 || nextIndex >= data.accounts.length) {
          console.error(`Error: invalid account number "${opts.account}". Choose 1-${data.accounts.length}`)
          process.exit(1)
        }
        if (!data.accounts[nextIndex].enabled) {
          console.error(`Error: account ${opts.account} is disabled`)
          process.exit(1)
        }
      } else {
        // Find next available account
        nextIndex = (currentIndex + 1) % data.accounts.length
        while (nextIndex !== currentIndex && !data.accounts[nextIndex].enabled) {
          nextIndex = (nextIndex + 1) % data.accounts.length
        }
        if (nextIndex === currentIndex) {
          console.error("Error: No other enabled accounts available")
          process.exit(1)
        }
      }

      const nextAccount = data.accounts[nextIndex]
      const nextLabel = nextAccount.label || `Account ${nextIndex + 1}`

      // Update rotation
      data.rotationIndex = nextIndex
      saveAccounts(data)
      saveRotationState({ lastUsedIndex: nextIndex })

      console.log(`Switching to: ${nextLabel}`)
      console.log(`\nTo resume, run: /handoff resume ${handoff.path}`)

      log("info", "force-handoff", {
        fromIndex: currentIndex,
        toIndex: nextIndex,
        handoffId: handoff.id,
      })
    } catch (error) {
      console.error("Error creating handoff:", error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

program
  .command("handoffs")
  .description("List all handoffs")
  .action(() => {
    const handoffs = listHandoffs()
    if (handoffs.length === 0) {
      console.log("No handoffs found.")
      return
    }
    console.log(`Found ${handoffs.length} handoff(s):\n`)
    for (const handoff of handoffs) {
      const date = new Date(handoff.timestamp).toISOString()
      const account = handoff.metadata.accountIndex + 1
      console.log(`  ${handoff.id}`)
      console.log(`    Date: ${date}`)
      console.log(`    Account: ${account}`)
      console.log(`    Language: ${handoff.language}`)
      console.log(`    Path: ${handoff.path}`)
      console.log()
    }
  })

program.parse()
