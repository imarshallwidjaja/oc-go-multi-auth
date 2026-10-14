// Account selection policy shared by the V1 fetch replay loop and the V2 hooks:
// availability, cooldowns, primary-before-overage preference, advisory usage
// lookups, and generation-guarded settlement of outcomes.
import type { PenaltyClassification } from "./classification.js"
import { callerAbortError } from "./classification.js"
import { log } from "./logger.js"
import { USAGE_URL } from "./opencode.js"
import { selectAccount } from "./rotate.js"
import type { GoAccount } from "./types.js"
import { accountHasRemaining, MAX_USAGE_BODY_BYTES, parseUsagePayload, readBoundedJson } from "./usage.js"

export interface RotatingFetchState {
  activeIndex: number
  blocked: Set<number>
  cooldownUntil: Map<number, number>
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type Candidate = { account: GoAccount; index: number }
export type AdvisoryCandidate = Candidate & { advisory: boolean; generation?: number }
export type Logger = typeof log

/**
 * One attempt's claim on an account. Outcomes settle only while the account's
 * availability generation is unchanged, so a late result cannot overwrite a newer one.
 */
export interface Lease {
  readonly index: number
  readonly account: GoAccount
  readonly generation: number
  readonly requestGeneration: number
}

/**
 * What settling a penalty did. "covered" means the lease was stale only because
 * another attempt already recorded an equal or stronger penalty for the account:
 * the failure is real and attributable, and nothing needs mutating.
 * "superseded" means a newer outcome replaced the lease's view of the account.
 */
export type PenaltyOutcome = "applied" | "covered" | "superseded"

export interface AccountPoolOptions {
  logger?: Logger
  onStickyChange?: (account: GoAccount) => void
  now?: () => number
  /** Used for advisory usage lookups. */
  fetch?: FetchFn
}

const NO_ACCOUNTS: ReadonlySet<number> = new Set()
const USAGE_LOOKUP_TIMEOUT_MS = 750
const USAGE_CACHE_TTL_MS = 5_000

type UsageGuidance = { eligible: boolean; useBalance: boolean }

function discardResponse(response: Response) {
  if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => {})
}

async function readUsageGuidance(response: Response, signal: AbortSignal): Promise<UsageGuidance> {
  if (response.status !== 200) {
    discardResponse(response)
    return { eligible: false, useBalance: false }
  }
  const json = await readBoundedJson(response, MAX_USAGE_BODY_BYTES, signal)
  if (!json.ok) return { eligible: false, useBalance: false }
  const payload = parseUsagePayload(json.value)
  if (!payload) return { eligible: false, useBalance: false }
  return {
    eligible: accountHasRemaining(payload),
    useBalance: payload.useBalance === true,
  }
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(callerAbortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(callerAbortError(signal))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort)
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export function labelFor(accounts: GoAccount[], index: number) {
  return accounts[index]?.label || `account-${index}`
}

export type AccountPool = ReturnType<typeof createAccountPool>

export function createAccountPool(
  accounts: GoAccount[],
  lastIndex: number,
  options: AccountPoolOptions = {},
) {
  const initial = selectAccount(accounts, lastIndex)
  const state: RotatingFetchState = {
    activeIndex: initial.index,
    blocked: new Set(),
    cooldownUntil: new Map(),
  }
  const logger = options.logger ?? log
  const now = options.now ?? Date.now
  const useFetch = options.fetch ?? globalThis.fetch
  const lifecycle = new AbortController()
  const availabilityGenerations = accounts.map(() => 0)
  let nextRequestGeneration = 0
  let latestSuccessfulRequestGeneration = 0
  const usageCache = new Map<number, { generation: number; expiresAt: number; eligible: boolean }>()
  const usageInFlight = new Map<number, { generation: number; promise: Promise<boolean> }>()
  const useBalanceWarned = new Set<number>()
  // Cooling primaries already tried through an advisory lease in their current
  // cooldown. V1 tracks this per request; host-driven V2 retries have no request
  // object, so the pool remembers until the account is available again.
  const advisoryAttempted = new Set<number>()

  const isAvailable = (index: number, time: number) => {
    if (!accounts[index]?.enabled || state.blocked.has(index)) return false
    const until = state.cooldownUntil.get(index)
    if (until === undefined) return true
    if (until > time) return false
    state.cooldownUntil.delete(index)
    advisoryAttempted.delete(index)
    return true
  }

  const isPrimary = (index: number) => accounts[index]?.role !== "overage_fallback"

  const nextMatching = (
    afterIndex: number,
    attempted: ReadonlySet<number>,
    time: number,
    primaryOnly: boolean,
  ): Candidate | null => {
    for (let offset = 1; offset <= accounts.length; offset++) {
      const index = (afterIndex + offset) % accounts.length
      if (attempted.has(index) || !isAvailable(index, time)) continue
      if (primaryOnly !== isPrimary(index)) continue
      return { account: accounts[index], index }
    }
    return null
  }

  const nextAvailable = (afterIndex: number, attempted: ReadonlySet<number>, time: number) =>
    nextMatching(afterIndex, attempted, time, true)
    ?? nextMatching(afterIndex, attempted, time, false)

  /** Preferred available account, skipping the `excluded` indexes (a caller's own failed attempts). */
  const firstAvailable = (time: number, excluded: ReadonlySet<number> = NO_ACCOUNTS): Candidate | null => {
    const activeIndex = state.activeIndex
    const stickyUsable = !excluded.has(activeIndex) && isAvailable(activeIndex, time)
    if (stickyUsable && isPrimary(activeIndex)) {
      return { account: accounts[activeIndex], index: activeIndex }
    }
    const primary = nextMatching(activeIndex, excluded, time, true)
    if (primary) return primary
    if (stickyUsable) {
      return { account: accounts[activeIndex], index: activeIndex }
    }
    return nextMatching(activeIndex, excluded, time, false)
  }

  const earliestCooldown = () => {
    let earliest: number | undefined
    for (let index = 0; index < accounts.length; index++) {
      if (!accounts[index]?.enabled || state.blocked.has(index)) continue
      const until = state.cooldownUntil.get(index)
      if (until === undefined) continue
      if (earliest === undefined || until < earliest) earliest = until
    }
    return earliest
  }

  /**
   * Enabled account to try when none is available: the sticky one, else the next
   * enabled one. Accounts in `excluded` are skipped unless every enabled account is.
   */
  const probeCandidate = (excluded: ReadonlySet<number> = NO_ACCOUNTS): Candidate | null => {
    const stickyIndex = state.activeIndex
    for (const skip of [excluded, NO_ACCOUNTS]) {
      for (let offset = 0; offset < accounts.length; offset++) {
        const index = (stickyIndex + offset) % accounts.length
        if (accounts[index]?.enabled && !skip.has(index)) return { account: accounts[index], index }
      }
    }
    return null
  }

  const isCoolingPrimary = (index: number, time: number, attempted: ReadonlySet<number>) => {
    if (attempted.has(index) || !isPrimary(index)) return false
    if (!accounts[index]?.enabled || state.blocked.has(index)) return false
    const until = state.cooldownUntil.get(index)
    return until !== undefined && until > time
  }

  const coolingPrimaries = (afterIndex: number, attempted: ReadonlySet<number>, time: number) => {
    const result: number[] = []
    for (let offset = 1; offset <= accounts.length; offset++) {
      const index = (afterIndex + offset) % accounts.length
      if (isCoolingPrimary(index, time, attempted)) result.push(index)
    }
    return result
  }

  const isStillAdvisoryEligible = (index: number, generation: number, attempted: ReadonlySet<number>) => {
    if (availabilityGenerations[index] !== generation) return false
    return isCoolingPrimary(index, now(), attempted)
  }

  const lookupUsage = async (index: number): Promise<boolean> => {
    const account = accounts[index]
    const controller = new AbortController()
    const onDispose = () => controller.abort()
    lifecycle.signal.addEventListener("abort", onDispose)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error("usage lookup timeout"))
      }, USAGE_LOOKUP_TIMEOUT_MS)
    })
    const lookup = (async () => {
      const response = await useFetch(new Request(USAGE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${account.apiKey}` },
        signal: controller.signal,
      }))
      return readUsageGuidance(response, controller.signal)
    })()
    try {
      const parsed = await Promise.race([lookup, timeout])
      if (parsed.useBalance && !useBalanceWarned.has(index)) {
        useBalanceWarned.add(index)
        logger("warn", "OpenCode Go Use balance is enabled", {
          label: labelFor(accounts, index),
          index,
        })
      }
      return parsed.eligible
    } catch {
      controller.abort()
      return false
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      lifecycle.signal.removeEventListener("abort", onDispose)
    }
  }

  const getOrStartUsageLookup = (index: number) => {
    const generation = availabilityGenerations[index]
    const cached = usageCache.get(index)
    if (cached && cached.generation === generation && cached.expiresAt > now()) {
      return Promise.resolve(cached.eligible)
    }
    const inflight = usageInFlight.get(index)
    if (inflight && inflight.generation === generation) return inflight.promise

    const promise = lookupUsage(index).then((eligible) => {
      if (availabilityGenerations[index] === generation && !lifecycle.signal.aborted) {
        usageCache.set(index, {
          generation,
          expiresAt: now() + USAGE_CACHE_TTL_MS,
          eligible,
        })
      }
      return eligible
    }).finally(() => {
      const current = usageInFlight.get(index)
      if (current?.promise === promise) usageInFlight.delete(index)
    })
    usageInFlight.set(index, { generation, promise })
    return promise
  }

  /** Asks the usage endpoint whether a cooling primary has quota again; bounded by the lookup timeout. */
  const selectAdvisoryPrimary = async (
    afterIndex: number,
    attempted: ReadonlySet<number>,
    signal: AbortSignal,
  ): Promise<AdvisoryCandidate | null> => {
    if (signal.aborted) throw callerAbortError(signal)
    const candidates = coolingPrimaries(afterIndex, attempted, now())
    if (candidates.length === 0) return null
    const results = await Promise.all(candidates.map(async (index) => {
      if (signal.aborted) throw callerAbortError(signal)
      return {
        index,
        generation: availabilityGenerations[index],
        eligible: await raceAbort(getOrStartUsageLookup(index), signal),
      }
    }))
    const availablePrimary = nextMatching(afterIndex, attempted, now(), true)
    if (availablePrimary) return { account: availablePrimary.account, index: availablePrimary.index, advisory: false }
    for (const { index, generation, eligible } of results) {
      if (!eligible || !isStillAdvisoryEligible(index, generation, attempted)) continue
      return { account: accounts[index], index, advisory: true, generation }
    }
    return null
  }

  const startRequest = () => ++nextRequestGeneration

  const lease = (candidate: Candidate, requestGeneration = startRequest()): Lease => ({
    index: candidate.index,
    account: candidate.account,
    generation: availabilityGenerations[candidate.index],
    requestGeneration,
  })

  /**
   * Records a success. The sticky account moves only for the newest successful
   * request, so a slow older success cannot undo a newer failover.
   */
  const settleSuccess = (
    settled: Lease,
    details: Record<string, unknown> = {},
  ) => {
    if (lifecycle.signal.aborted) return false
    const accepted = availabilityGenerations[settled.index] === settled.generation
    if (accepted) {
      availabilityGenerations[settled.index]++
      state.cooldownUntil.delete(settled.index)
      advisoryAttempted.delete(settled.index)
    }
    if (accepted && settled.requestGeneration > latestSuccessfulRequestGeneration) {
      latestSuccessfulRequestGeneration = settled.requestGeneration
      if (state.activeIndex !== settled.index) {
        const previousIndex = state.activeIndex
        state.activeIndex = settled.index
        options.onStickyChange?.(settled.account)
        logger("info", "sticky account replaced", {
          fromLabel: labelFor(accounts, previousIndex),
          fromIndex: previousIndex,
          toLabel: labelFor(accounts, settled.index),
          toIndex: settled.index,
          ...details,
        })
      }
    }
    return accepted
  }

  const coversPenalty = (index: number, classification: PenaltyClassification) => {
    if (state.blocked.has(index)) return true
    if (classification.class === "auth") return false
    const until = state.cooldownUntil.get(index)
    return until !== undefined && until > now()
  }

  /** Applies an auth block or quota cooldown when no newer outcome already settled the account. */
  const settlePenalty = (settled: Lease, classification: PenaltyClassification): PenaltyOutcome => {
    if (lifecycle.signal.aborted) return "superseded"
    if (availabilityGenerations[settled.index] !== settled.generation) {
      return coversPenalty(settled.index, classification) ? "covered" : "superseded"
    }
    availabilityGenerations[settled.index]++
    if (classification.class === "auth") {
      state.blocked.add(settled.index)
      state.cooldownUntil.delete(settled.index)
    } else {
      state.cooldownUntil.set(settled.index, classification.cooldownUntil)
    }
    return "applied"
  }

  /** Cooling primaries to skip for advisory lookups. An account is forgotten once it is available again. */
  const advisoryAttempts = (): ReadonlySet<number> => advisoryAttempted

  /**
   * Leases a candidate chosen before an await, in one synchronous step: nothing
   * can settle or claim in between. Fails when the account is excluded, no longer
   * available, or, for an advisory primary, has changed state since the lookup
   * captured its generation or was already offered in this cooldown. A successful
   * advisory claim marks the primary as tried.
   */
  const claimCandidate = (candidate: AdvisoryCandidate, excluded: ReadonlySet<number> = NO_ACCOUNTS): Lease | null => {
    if (lifecycle.signal.aborted || excluded.has(candidate.index)) return null
    if (candidate.advisory) {
      if (candidate.generation === undefined) return null
      if (!isStillAdvisoryEligible(candidate.index, candidate.generation, advisoryAttempted)) return null
      advisoryAttempted.add(candidate.index)
    } else if (!isAvailable(candidate.index, now())) {
      return null
    }
    return lease(candidate)
  }

  const availabilityGeneration = (index: number) => availabilityGenerations[index]

  return {
    accounts,
    state,
    logger,
    now,
    signal: lifecycle.signal,
    isAvailable,
    isPrimary,
    nextMatching,
    nextAvailable,
    firstAvailable,
    earliestCooldown,
    probeCandidate,
    isStillAdvisoryEligible,
    selectAdvisoryPrimary,
    advisoryAttempts,
    claimCandidate,
    availabilityGeneration,
    startRequest,
    lease,
    settleSuccess,
    settlePenalty,
    dispose() {
      lifecycle.abort()
      usageCache.clear()
      usageInFlight.clear()
      advisoryAttempted.clear()
    },
  }
}
