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

export interface LanguageToolConfig {
  mode: "local" | "remote"
  url?: string
  localPort?: number
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
  const sortedMatches = [...matches].sort((a, b) => b.offset - a.offset)

  let correctedText = text

  for (const match of sortedMatches) {
    if (match.replacements.length === 0) continue

    const replacement = match.replacements[0].value
    const before = correctedText.slice(0, match.offset)
    const after = correctedText.slice(match.offset + match.length)
    correctedText = before + replacement + after
  }

  return correctedText
}

async function checkLocal(text: string, port: number): Promise<LanguageToolResult> {
  const response = await fetch(`http://localhost:${port}/v2/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      text,
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
}

async function checkRemote(text: string, url: string): Promise<LanguageToolResult> {
  const response = await fetch(`${url}/v2/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      text,
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
}

export async function languageToolCheck(
  text: string,
  configOrUrl: string | LanguageToolConfig = { mode: "local", localPort: 8010 },
): Promise<LanguageToolResult> {
  if (!text || text.trim() === "") {
    return {
      correctedText: text,
      language: "en",
      matches: [],
    }
  }

  const config: LanguageToolConfig =
    typeof configOrUrl === "string"
      ? { mode: "remote", url: configOrUrl }
      : configOrUrl

  log("info", "calling languagetool", {
    mode: config.mode,
    url: config.url,
    port: config.localPort,
    textLength: text.length,
  })

  try {
    let result: LanguageToolResult

    if (config.mode === "local") {
      result = await checkLocal(text, config.localPort || 8010)
    } else {
      if (!config.url) throw new Error("LanguageTool URL required for remote mode")
      result = await checkRemote(text, config.url)
    }

    log("info", "languagetool check completed", {
      language: result.language,
      corrections: result.matches.length,
    })

    return result
  } catch (error) {
    log("error", "languagetool check failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
