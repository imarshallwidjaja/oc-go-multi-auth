import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import { log } from "./logger"
import { languageToolCheck } from "./languagetool"
import { cavemanCompress } from "./caveman"

export interface Handoff {
  id: string
  compactionSummary: string
  compressedMessages: string
  codeBlocks: string[]
  modifiedFiles: string[]
  timestamp: number
  path: string
  language: string
  metadata: {
    accountIndex: number
    sessionId: string
    originalMessageCount: number
    compressedSize: number
    originalSize: number
  }
}

export interface Message {
  role: "user" | "assistant" | "system"
  content: string
}

interface HandoffConfig {
  maxHandoffs: number
  handoffRetentionDays: number
  languagetoolUrl: string
  cavemanUrl: string
}

const DEFAULT_CONFIG: HandoffConfig = {
  maxHandoffs: 10,
  handoffRetentionDays: 7,
  languagetoolUrl: "http://192.168.1.69:8010",
  cavemanUrl: "http://192.168.1.69:3000",
}

function getHandoffDir(): string {
  return join(process.env.HOME ?? "/root", ".config", "opencode", "handoffs")
}

function ensureHandoffDir(): void {
  const dir = getHandoffDir()
  mkdirSync(dir, { recursive: true })
}

function separateTextAndCode(messages: Message[]): { naturalText: string; codeBlocks: string[] } {
  const codeBlockRegex = /```[\s\S]*?```/g
  const codeBlocks: string[] = []
  let naturalText = ""

  for (const message of messages) {
    const content = message.content
    let lastIndex = 0
    let match

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      naturalText += content.slice(lastIndex, match.index) + "\n"
      // Add code block
      codeBlocks.push(match[0])
      lastIndex = match.index + match[0].length
    }

    // Add remaining text
    naturalText += content.slice(lastIndex) + "\n"
  }

  return { naturalText: naturalText.trim(), codeBlocks }
}

function simpleCompress(text: string): string {
  // Simple compression: remove extra whitespace and stop words
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once",
  ])

  return text
    .split(/\s+/)
    .filter((word) => !stopWords.has(word.toLowerCase()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

export async function createHandoff(
  compactionSummary: string,
  recentMessages: Message[],
  modifiedFiles: string[],
  accountIndex: number,
  sessionId: string,
  config: Partial<HandoffConfig> = {},
): Promise<Handoff> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const handoffId = randomUUID()
  const handoffPath = join(getHandoffDir(), `${handoffId}.json`)

  log("info", "creating handoff", {
    id: handoffId,
    messageCount: recentMessages.length,
    fileCount: modifiedFiles.length,
  })

  // 1. Separate text from code
  const { naturalText, codeBlocks } = separateTextAndCode(recentMessages)

  // 2. Send to LanguageTool (auto-detect language)
  let correctedText = naturalText
  let language = "en"
  try {
    const ltResult = await languageToolCheck(naturalText, fullConfig.languagetoolUrl)
    correctedText = ltResult.correctedText
    language = ltResult.language
    log("info", "languagetool check completed", {
      language,
      corrections: ltResult.matches.length,
    })
  } catch (error) {
    log("warn", "languagetool unavailable, skipping spellcheck", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // 3. Send to Caveman (MLM compression)
  let compressedText: string
  try {
    compressedText = await cavemanCompress(correctedText, language, fullConfig.cavemanUrl)
    log("info", "caveman compression completed", {
      originalSize: correctedText.length,
      compressedSize: compressedText.length,
      ratio: (compressedText.length / correctedText.length * 100).toFixed(1) + "%",
    })
  } catch (error) {
    log("warn", "caveman unavailable, using simple compression", {
      error: error instanceof Error ? error.message : String(error),
    })
    compressedText = simpleCompress(correctedText)
  }

  // 4. Create handoff
  const handoff: Handoff = {
    id: handoffId,
    compactionSummary,
    compressedMessages: compressedText,
    codeBlocks,
    modifiedFiles,
    timestamp: Date.now(),
    path: handoffPath,
    language,
    metadata: {
      accountIndex,
      sessionId,
      originalMessageCount: recentMessages.length,
      compressedSize: compressedText.length,
      originalSize: naturalText.length,
    },
  }

  return handoff
}

export function saveHandoff(handoff: Handoff): void {
  ensureHandoffDir()

  // Validate handoff
  if (!handoff.compactionSummary || handoff.compactionSummary.trim() === "") {
    throw new Error("Compaction summary cannot be empty")
  }

  // Save handoff
  writeFileSync(handoff.path, JSON.stringify(handoff, null, 2) + "\n", "utf-8")

  log("info", "handoff saved", {
    id: handoff.id,
    path: handoff.path,
    size: JSON.stringify(handoff).length,
  })

  // Cleanup old handoffs
  cleanupOldHandoffs()
}

export function loadHandoff(path: string): Handoff | null {
  if (!existsSync(path)) {
    log("warn", "handoff not found", { path })
    return null
  }

  try {
    const data = readFileSync(path, "utf-8")
    return JSON.parse(data) as Handoff
  } catch (error) {
    log("error", "failed to load handoff", {
      path,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function cleanupOldHandoffs(): void {
  const dir = getHandoffDir()
  if (!existsSync(dir)) return

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      path: join(dir, f),
      stat: existsSync(join(dir, f)) ? null : null,
    }))

  // Sort by modification time (newest first)
  const handoffs = files
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(f.path, "utf-8")) as Handoff
        return { ...f, timestamp: data.timestamp }
      } catch {
        return { ...f, timestamp: 0 }
      }
    })
    .sort((a, b) => b.timestamp - a.timestamp)

  // Remove old handoffs (keep max 10)
  const maxHandoffs = 10
  if (handoffs.length > maxHandoffs) {
    const toRemove = handoffs.slice(maxHandoffs)
    for (const handoff of toRemove) {
      try {
        unlinkSync(handoff.path)
        log("info", "removed old handoff", { path: handoff.path })
      } catch (error) {
        log("warn", "failed to remove old handoff", {
          path: handoff.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  // Remove handoffs older than 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const oldHandoffs = handoffs.filter((h) => h.timestamp < sevenDaysAgo)
  for (const handoff of oldHandoffs) {
    try {
      unlinkSync(handoff.path)
      log("info", "removed expired handoff", { path: handoff.path })
    } catch (error) {
      log("warn", "failed to remove expired handoff", {
        path: handoff.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export function listHandoffs(): Handoff[] {
  const dir = getHandoffDir()
  if (!existsSync(dir)) return []

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))

  return files
    .map((f) => {
      try {
        const data = readFileSync(join(dir, f), "utf-8")
        return JSON.parse(data) as Handoff
      } catch {
        return null
      }
    })
    .filter((h): h is Handoff => h !== null)
    .sort((a, b) => b.timestamp - a.timestamp)
}
