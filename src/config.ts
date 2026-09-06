import { log } from "./logger"

export interface SessionManagerConfig {
  cooldownMs: number
  autoHandoff: boolean
  autoResume: boolean
  tryCooldownAccounts: boolean
  maxWaitTimeMs: number
  notifyCooldown: boolean
  maxHandoffs: number
  handoffRetentionDays: number
  languagetoolUrl: string
  cavemanUrl: string
}

const DEFAULT_CONFIG: SessionManagerConfig = {
  cooldownMs: 5 * 60 * 60 * 1000,  // 5 hours
  autoHandoff: true,
  autoResume: true,
  tryCooldownAccounts: true,
  maxWaitTimeMs: 5 * 60 * 1000,  // 5 minutes
  notifyCooldown: true,
  maxHandoffs: 10,
  handoffRetentionDays: 7,
  languagetoolUrl: "http://192.168.1.69:8010",
  cavemanUrl: "http://192.168.1.69:3000",
}

export function loadConfig(): SessionManagerConfig {
  try {
    // In a real implementation, this would load from opencode.json
    // For now, return defaults
    log("info", "loading session manager config", {
      cooldownMs: DEFAULT_CONFIG.cooldownMs,
      autoHandoff: DEFAULT_CONFIG.autoHandoff,
      languagetoolUrl: DEFAULT_CONFIG.languagetoolUrl,
      cavemanUrl: DEFAULT_CONFIG.cavemanUrl,
    })

    return DEFAULT_CONFIG
  } catch (error) {
    log("warn", "failed to load config, using defaults", {
      error: error instanceof Error ? error.message : String(error),
    })
    return DEFAULT_CONFIG
  }
}

export function validateConfig(config: Partial<SessionManagerConfig>): SessionManagerConfig {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }

  // Validate cooldown
  if (fullConfig.cooldownMs < 0) {
    log("warn", "invalid cooldown, using default", { cooldownMs: fullConfig.cooldownMs })
    fullConfig.cooldownMs = DEFAULT_CONFIG.cooldownMs
  }

  // Validate URLs
  try {
    new URL(fullConfig.languagetoolUrl)
  } catch {
    log("warn", "invalid languagetool URL, using default", { url: fullConfig.languagetoolUrl })
    fullConfig.languagetoolUrl = DEFAULT_CONFIG.languagetoolUrl
  }

  try {
    new URL(fullConfig.cavemanUrl)
  } catch {
    log("warn", "invalid caveman URL, using default", { url: fullConfig.cavemanUrl })
    fullConfig.cavemanUrl = DEFAULT_CONFIG.cavemanUrl
  }

  // Validate max handoffs
  if (fullConfig.maxHandoffs < 1 || fullConfig.maxHandoffs > 100) {
    log("warn", "invalid maxHandoffs, using default", { maxHandoffs: fullConfig.maxHandoffs })
    fullConfig.maxHandoffs = DEFAULT_CONFIG.maxHandoffs
  }

  // Validate retention days
  if (fullConfig.handoffRetentionDays < 1 || fullConfig.handoffRetentionDays > 30) {
    log("warn", "invalid handoffRetentionDays, using default", {
      handoffRetentionDays: fullConfig.handoffRetentionDays,
    })
    fullConfig.handoffRetentionDays = DEFAULT_CONFIG.handoffRetentionDays
  }

  return fullConfig
}
