import { log } from "./logger"
import type { LanguageToolConfig } from "./languagetool"
import type { CavemanConfig } from "./caveman"

export interface SessionManagerConfig {
  cooldownMs: number
  autoHandoff: boolean
  autoResume: boolean
  tryCooldownAccounts: boolean
  maxWaitTimeMs: number
  notifyCooldown: boolean
  maxHandoffs: number
  handoffRetentionDays: number
  languagetool: LanguageToolConfig
  caveman: CavemanConfig
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
  languagetool: { mode: "local", localPort: 8010 },
  caveman: { mode: "local" },
}

export function loadConfig(): SessionManagerConfig {
  try {
    log("info", "loading session manager config", {
      cooldownMs: DEFAULT_CONFIG.cooldownMs,
      autoHandoff: DEFAULT_CONFIG.autoHandoff,
      languagetoolMode: DEFAULT_CONFIG.languagetool.mode,
      cavemanMode: DEFAULT_CONFIG.caveman.mode,
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
