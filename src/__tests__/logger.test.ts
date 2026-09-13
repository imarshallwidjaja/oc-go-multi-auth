import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "../logger"

it("resolves the log path from the current HOME for every write", () => {
  const suiteHome = process.env.HOME
  const currentHome = mkdtempSync(join(tmpdir(), "oc-go-multi-auth-logger-"))

  try {
    process.env.HOME = currentHome
    log("info", "logger isolation probe")

    expect(existsSync(join(currentHome, ".config", "opencode", "oc-go-multi-auth.log"))).toBe(true)
  } finally {
    process.env.HOME = suiteHome
    rmSync(currentHome, { recursive: true, force: true })
  }
})
