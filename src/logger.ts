import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"

const dir = join(process.env.HOME ?? "/root", ".config", "opencode")
const file = join(dir, "oc-go-multi-auth.log")

let started = false

function ensure() {
  if (started) return
  mkdirSync(dir, { recursive: true })
  started = true
}

export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  ensure()
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  })
  try {
    appendFileSync(file, entry + "\n", "utf-8")
  } catch {
    // silently ignore log write failures
  }
}
