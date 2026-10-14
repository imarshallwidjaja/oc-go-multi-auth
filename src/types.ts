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
  /** Legacy sticky index. Read for compatibility; the runtime no longer writes it. */
  rotationIndex: number
}

export interface RotationState {
  lastUsedIndex: number
  /** Non-secret account identity from accountId(); preferred over lastUsedIndex. */
  lastUsedAccount?: string
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
