import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const originalHome = process.env.HOME
const testHome = mkdtempSync(join(tmpdir(), "oc-go-multi-auth-tests-"))

process.env.HOME = testHome

afterAll(() => {
  if (process.env.HOME === testHome) process.env.HOME = originalHome
  rmSync(testHome, { recursive: true, force: true })
})
