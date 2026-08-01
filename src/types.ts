export type AccountRole = "primary" | "overage_fallback"

export interface GoAccount {
  apiKey: string
  label?: string
  addedAt: number
  enabled: boolean
  role: AccountRole
}

export interface AccountsFile {
  version: 1
  accounts: GoAccount[]
  rotationIndex: number
}

export interface RotationState {
  lastUsedIndex: number
}

export function normalizeAccountRole(role: unknown): AccountRole {
  return role === "overage_fallback" ? "overage_fallback" : "primary"
}

/** Returns a role only for exact primary / overage_fallback strings. */
export function parseAccountRole(value: unknown): AccountRole | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (normalized === "primary" || normalized === "overage_fallback") return normalized
  return null
}
