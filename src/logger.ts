import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"

const started = new Set<string>()

function ensure(dir: string) {
  if (started.has(dir)) return
  mkdirSync(dir, { recursive: true })
  started.add(dir)
}

export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  const dir = join(process.env.HOME ?? "/root", ".config", "opencode")
  const file = join(dir, "oc-go-multi-auth.log")
  ensure(dir)
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
