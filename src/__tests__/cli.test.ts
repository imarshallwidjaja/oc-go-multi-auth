import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { loadAccounts, saveAccounts } from "../storage"

const origHome = process.env.HOME
let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "go-cli-test-"))
  process.env.HOME = tmpHome
})

afterEach(() => {
  process.env.HOME = origHome
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

async function runCli(...args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../cli.ts"), ...args], {
    env: { ...process.env, HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("oc-go-multi-auth cli roles", () => {
  it("reports the package version", async () => {
    const packageJson = await Bun.file(join(import.meta.dir, "../../package.json")).json()
    const result = await runCli("--version")

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(packageJson.version)
  })

  it("adds with --role and updates via set-role", async () => {
    expect((await runCli("add", "--key", "go_a", "--label", "alpha")).exitCode).toBe(0)
    expect((await runCli("add", "--key", "go_b", "--label", "beta", "--role", "overage_fallback")).exitCode).toBe(0)

    const listed = await runCli("list")
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain("[primary]")
    expect(listed.stdout).toContain("[overage_fallback]")

    expect((await runCli("set-role", "2", "primary")).exitCode).toBe(0)
    expect(loadAccounts().accounts.map((a) => a.role)).toEqual(["primary", "primary"])

    const status = await runCli("status")
    expect(status.stdout).toContain("Primaries: 2")
    expect(status.stdout).toContain("Overage fallbacks: 0")
  })

  it("rejects invalid roles", async () => {
    expect((await runCli("add", "--key", "go_a", "--role", "paid")).exitCode).toBe(1)
    expect((await runCli("add", "--key", "go_a")).exitCode).toBe(0)
    expect((await runCli("set-role", "1", "paid")).exitCode).toBe(1)
  })

  it("prints the usage report without leaking API keys", async () => {
    const empty = await runCli("usage")
    expect(empty.exitCode).toBe(0)
    expect(empty.stdout).toContain("No Go accounts configured.")

    saveAccounts({
      version: 1,
      accounts: [
        { apiKey: "go_secret_key_x1ab", label: "Work", addedAt: Date.now(), enabled: false, role: "primary" },
        { apiKey: "go_secret_key_old1", addedAt: Date.now(), enabled: false, role: "overage_fallback" },
      ],
      rotationIndex: 0,
    })
    const listed = await runCli("usage")
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain("OpenCode Go usage")
    expect(listed.stdout).toContain("1. Work  [primary]  disabled (not queried)")
    expect(listed.stdout).toContain("2. Account 2  [overage_fallback]  disabled (not queried)")
    expect(listed.stdout).not.toContain("go_secret_key_x1ab")
    expect(listed.stdout).not.toContain("go_secret_key_old1")
    expect(listed.stderr).toBe("")
  })
})
