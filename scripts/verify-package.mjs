// Builds the package, packs it once, and checks the archive that would be published.
//
// Usage: node scripts/verify-package.mjs [--out <dir>]
//
// Progress goes to stderr. The only stdout line is the absolute path of the
// verified tarball, so callers can capture it. Exits non-zero on any failed check.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PUBLIC_NAME = "oc-go-multi-auth"
const ROOT_FILES = new Set(["README.md", "LICENSE", "package.json"])
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const log = (message) => console.error(`verify-package: ${message}`)

function parseOut(argv) {
  const index = argv.indexOf("--out")
  if (index === -1) return join(root, ".tmp", "package")
  const value = argv[index + 1]
  if (!value) throw new Error("--out requires a directory")
  return resolve(value)
}

// Child stdout is routed to stderr unless the caller needs to capture it.
function run(command, args, options = {}) {
  const { capture = false, ...rest } = options
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : 2, 2],
    ...rest,
  })
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${[command, ...args].join(" ")} exited with status ${result.status}`)
  return result.stdout
}

function declaredPaths(pkg) {
  const paths = new Set()
  const visit = (value) => {
    if (typeof value === "string") paths.add(value.replace(/^\.\//, ""))
    else if (value && typeof value === "object") Object.values(value).forEach(visit)
  }
  visit(pkg.main)
  visit(pkg.types)
  visit(pkg.bin)
  visit(pkg.exports)
  return paths
}

function checkArchiveContents(pkg, files) {
  const present = new Set(files)
  for (const required of ROOT_FILES) assert.ok(present.has(required), `archive is missing ${required}`)
  for (const path of declaredPaths(pkg)) assert.ok(present.has(path), `package.json declares ${path} but the archive does not contain it`)
  const unexpected = files.filter((path) => !ROOT_FILES.has(path) && !/^dist\/[^/]+\.(js|d\.ts)$/.test(path))
  assert.deepEqual(unexpected, [], `archive contains files outside the public allowlist: ${unexpected.join(", ")}`)
  const retired = files.filter((path) => path.includes("v2-provider"))
  assert.deepEqual(retired, [], `archive contains retired native-provider output: ${retired.join(", ")}`)
}

// The install smoke test cannot catch an undeclared dependency that npm happens
// to hoist from another package, so check the built output's bare imports directly.
function checkImportsAreDeclared(pkg) {
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])
  const missing = new Set()
  for (const file of readdirSync(join(root, "dist"))) {
    const text = readFileSync(join(root, "dist", file), "utf8")
    for (const [, specifier] of text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']/g)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue
      const bare = specifier.replace(/^node:/, "")
      const name = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0]
      if (!builtinModules.includes(name) && !declared.has(name)) missing.add(`${name} (dist/${file})`)
    }
  }
  assert.deepEqual([...missing], [], `dist imports packages missing from dependencies/peerDependencies: ${[...missing].join(", ")}`)
}

const SMOKE_SCRIPT = `
import assert from "node:assert/strict"
import plugin from "oc-go-multi-auth"
import tui from "oc-go-multi-auth/tui"
import { GoAccountsRpc } from "oc-go-multi-auth/rpc"

assert.equal(typeof plugin.id, "string")
assert.equal(typeof plugin.setup, "function", "root export must expose the V2 setup()")
assert.equal(typeof plugin.server, "function", "root export must expose the V1 server()")
assert.equal(typeof tui.id, "string")
assert.equal(typeof tui.tui, "function", "./tui export must expose the V1 tui()")
assert.equal(typeof tui.setup, "function", "./tui export must expose the V2 setup()")
assert.equal(GoAccountsRpc.id, "oc-go-multi-auth")
assert.deepEqual(Object.keys(GoAccountsRpc.methods).sort(), ["add", "list", "remove", "setRole", "usage"])
await assert.rejects(import("oc-go-multi-auth/v2/provider"), "the retired ./v2/provider export must stay unpublished")
`

// Installs the archive into an empty project outside the checkout, so only the
// package's own dependencies are available. HOME is isolated so the CLI and
// plugin never read or write the real OpenCode config.
function smokeInstall(pkg, tarball) {
  const scratch = mkdtempSync(join(tmpdir(), "oc-go-multi-auth-smoke-"))
  try {
    const home = join(scratch, "home")
    const project = join(scratch, "project")
    mkdirSync(home)
    mkdirSync(project)
    writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }))
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") }

    log(`installing ${tarball} into ${project} (scripts disabled)`)
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error", tarball], { cwd: project, env })

    const installed = JSON.parse(readFileSync(join(project, "node_modules", PUBLIC_NAME, "package.json"), "utf8"))
    assert.equal(installed.name, PUBLIC_NAME)
    assert.equal(installed.version, pkg.version)

    writeFileSync(join(project, "smoke.mjs"), SMOKE_SCRIPT)
    for (const runtime of ["node", "bun"]) {
      log(`importing root, ./tui and ./rpc without OpenCode peers under ${runtime}`)
      run(runtime, ["smoke.mjs"], { cwd: project, env })
    }

    const bin = join(project, "node_modules", ".bin", PUBLIC_NAME)
    log("running the CLI bin (requires bun on PATH)")
    assert.equal(run(bin, ["--version"], { cwd: project, env, capture: true }).trim(), pkg.version)
    assert.match(run(bin, ["--help"], { cwd: project, env, capture: true }), /Manage OpenCode Go multi-account auth/)
    assert.match(run(bin, ["list"], { cwd: project, env, capture: true }), /No Go accounts configured\./)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function main() {
  const out = parseOut(process.argv.slice(2))
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  assert.equal(pkg.name, PUBLIC_NAME, `package name must be ${PUBLIC_NAME}`)
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "package version must be semver")

  log("building")
  rmSync(join(root, "dist"), { recursive: true, force: true })
  run("bun", ["run", "build"], { cwd: root })
  checkImportsAreDeclared(pkg)

  log(`packing into ${out}`)
  mkdirSync(out, { recursive: true })
  const [packed] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: root, capture: true }))
  assert.equal(packed.name, PUBLIC_NAME)
  assert.equal(packed.version, pkg.version)
  const tarball = join(out, packed.filename)
  assert.ok(existsSync(tarball), `npm pack did not produce ${tarball}`)

  checkArchiveContents(pkg, packed.files.map((file) => file.path))
  smokeInstall(pkg, tarball)

  log(`ok: ${packed.filename} (${packed.files.length} files, ${packed.size} bytes, ${packed.integrity})`)
  console.log(tarball)
}

try {
  main()
} catch (error) {
  console.error(`verify-package: FAILED: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
