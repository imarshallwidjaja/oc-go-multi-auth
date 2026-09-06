import { log } from "./logger"

export interface CavemanResponse {
  compressed: string
  language: string
  model: string
  compressionRatio: number
}

export interface CavemanConfig {
  mode: "local" | "remote"
  url?: string
  localCommand?: string
}

async function compressLocal(text: string, language: string): Promise<CavemanResponse> {
  const { spawn } = await import("child_process")

  return new Promise((resolve, reject) => {
    const caveman = spawn("npx", ["-y", "@caveman-ai/cli", "compress"], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    caveman.stdout.on("data", (data: Buffer) => {
      stdout += data.toString()
    })

    caveman.stderr.on("data", (data: Buffer) => {
      stderr += data.toString()
    })

    caveman.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Caveman exited with code ${code}: ${stderr}`))
        return
      }

      const lines = stdout.trim().split("\n")
      const compressed = lines[0] || text

      resolve({
        compressed,
        language,
        model: "caveman-local",
        compressionRatio: compressed.length / text.length,
      })
    })

    caveman.stdin.write(text)
    caveman.stdin.end()
  })
}

async function compressRemote(text: string, language: string, url: string): Promise<CavemanResponse> {
  const response = await fetch(`${url}/compress`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, language }),
  })

  if (!response.ok) {
    throw new Error(`Caveman API error: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as CavemanResponse
}

export async function cavemanCompress(
  text: string,
  language: string = "en",
  configOrUrl: string | CavemanConfig = "http://localhost:3000",
): Promise<string> {
  if (!text || text.trim() === "") {
    return text
  }

  const config: CavemanConfig =
    typeof configOrUrl === "string"
      ? { mode: configOrUrl.includes("localhost") || configOrUrl.includes("127.0.0.1") ? "local" : "remote", url: configOrUrl }
      : configOrUrl

  log("info", "calling caveman", {
    mode: config.mode,
    url: config.url,
    language,
    textLength: text.length,
  })

  try {
    let result: CavemanResponse

    if (config.mode === "local") {
      result = await compressLocal(text, language)
    } else {
      if (!config.url) throw new Error("Caveman URL required for remote mode")
      result = await compressRemote(text, language, config.url)
    }

    log("info", "caveman compression successful", {
      model: result.model,
      compressionRatio: result.compressionRatio,
      originalSize: text.length,
      compressedSize: result.compressed.length,
    })

    return result.compressed
  } catch (error) {
    log("error", "caveman compression failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export function detectLanguage(text: string): string {
  const frenchWords = [
    "le", "la", "les", "de", "des", "du", "un", "une", "et", "est",
    "sont", "avoir", "être", "faire", "aller", "venir", "prendre",
    "donner", "voir", "savoir", "pouvoir", "vouloir", "falloir",
  ]

  const englishWords = [
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
  ]

  const words = text.toLowerCase().split(/\s+/)
  let frenchCount = 0
  let englishCount = 0

  for (const word of words) {
    if (frenchWords.includes(word)) frenchCount++
    if (englishWords.includes(word)) englishCount++
  }

  if (frenchCount > englishCount) {
    return "fr"
  }

  return "en"
}
