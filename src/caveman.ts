import { log } from "./logger"

export interface CavemanResponse {
  compressed: string
  language: string
  model: string
  compressionRatio: number
}

export async function cavemanCompress(
  text: string,
  language: string = "en",
  url: string = "http://192.168.1.69:3000",
): Promise<string> {
  if (!text || text.trim() === "") {
    return text
  }

  log("info", "calling caveman", {
    url,
    language,
    textLength: text.length,
  })

  try {
    const response = await fetch(`${url}/compress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        language,
      }),
    })

    if (!response.ok) {
      throw new Error(`Caveman API error: ${response.status} ${response.statusText}`)
    }

    const result = (await response.json()) as CavemanResponse

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
  // Simple language detection based on common words
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

  // If more French words detected, return French
  if (frenchCount > englishCount) {
    return "fr"
  }

  // Default to English
  return "en"
}
