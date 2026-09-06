import { log } from "./logger"

export interface LanguageToolMatch {
  message: string
  shortMessage: string
  offset: number
  length: number
  replacements: Array<{ value: string }>
  context: {
    text: string
    offset: number
    length: number
  }
  rule: {
    id: string
    description: string
    issueType: string
    category: {
      id: string
      name: string
    }
  }
  language: {
    name: string
    code: string
  }
}

export interface LanguageToolResult {
  correctedText: string
  language: string
  matches: LanguageToolMatch[]
}

interface LanguageToolResponse {
  matches: LanguageToolMatch[]
  language: {
    name: string
    code: string
    detectedLanguage: {
      name: string
      code: string
      confidence: number
    }
  }
}

function applyCorrections(text: string, matches: LanguageToolMatch[]): string {
  // Sort matches by offset in descending order to avoid offset shifting
  const sortedMatches = [...matches].sort((a, b) => b.offset - a.offset)

  let correctedText = text

  for (const match of sortedMatches) {
    if (match.replacements.length === 0) continue

    // Apply the first replacement
    const replacement = match.replacements[0].value
    const before = correctedText.slice(0, match.offset)
    const after = correctedText.slice(match.offset + match.length)
    correctedText = before + replacement + after
  }

  return correctedText
}

export async function languageToolCheck(
  text: string,
  url: string = "http://192.168.1.69:8010",
): Promise<LanguageToolResult> {
  if (!text || text.trim() === "") {
    return {
      correctedText: text,
      language: "en",
      matches: [],
    }
  }

  log("info", "calling languagetool", {
    url,
    textLength: text.length,
  })

  try {
    const response = await fetch(`${url}/v2/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        text,
        // Auto-detect language
        language: "auto",
      }),
    })

    if (!response.ok) {
      throw new Error(`LanguageTool API error: ${response.status} ${response.statusText}`)
    }

    const result = (await response.json()) as LanguageToolResponse

    const correctedText = applyCorrections(text, result.matches)

    return {
      correctedText,
      language: result.language.detectedLanguage.code,
      matches: result.matches,
    }
  } catch (error) {
    log("error", "languagetool check failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
