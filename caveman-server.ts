#!/usr/bin/env bun
// Local Caveman HTTP server wrapper
// Wraps the Caveman CLI to provide an HTTP API for the plugin

import { spawn } from "child_process"

const PORT = 3000

async function compressText(text: string, language: string = "en"): Promise<string> {
  return new Promise((resolve, reject) => {
    const caveman = spawn("npx", ["-y", "@caveman-ai/cli", "compress"], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    caveman.stdout.on("data", (data) => {
      stdout += data.toString()
    })

    caveman.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    caveman.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Caveman exited with code ${code}: ${stderr}`))
        return
      }

      // Parse output - first line is compressed text, second is JSON stats
      const lines = stdout.trim().split("\n")
      const compressed = lines[0] || text
      resolve(compressed)
    })

    caveman.stdin.write(text)
    caveman.stdin.end()
  })
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/compress" && request.method === "POST") {
      try {
        const body = (await request.json()) as { text: string; language?: string }
        const { text, language = "en" } = body

        if (!text) {
          return new Response(JSON.stringify({ error: "text is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        }

        const compressed = await compressText(text, language)

        return new Response(
          JSON.stringify({
            compressed,
            language,
            model: "caveman-cli",
            compressionRatio: compressed.length / text.length,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        )
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        )
      }
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "caveman-wrapper" }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    return new Response("Not Found", { status: 404 })
  },
})

console.log(`Caveman HTTP wrapper running on http://localhost:${PORT}`)
console.log("Endpoints:")
console.log("  POST /compress - { text, language } -> { compressed, language, model, compressionRatio }")
console.log("  GET  /health   - Health check")
