// V1 transport: replays one request across accounts inside the host's fetch call.
import {
  callerAbortError,
  classifyResponse,
  DEFAULT_INSPECTION_TIMEOUT_MS,
  type ResponseClassification,
  type RotationReason,
} from "./classification.js"
import {
  createAccountPool,
  labelFor,
  type Candidate,
  type FetchFn,
  type Logger,
  type RotatingFetchState,
} from "./pool.js"
import type { GoAccount } from "./types.js"

export type { FetchFn, RotatingFetchState } from "./pool.js"

type WaitFn = (delayMs: number, signal: AbortSignal) => Promise<void>
type PreferenceReason = "preference_demotion"

interface RotatingFetchOptions {
  logger?: Logger
  onStickyChange?: (account: GoAccount) => void
  inspectionTimeoutMs?: number
  now?: () => number
  wait?: WaitFn
}

function discardResponse(response: Response) {
  if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => {})
}

function waitForCooldown(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)

    signal.addEventListener("abort", onAbort)
    if (signal.aborted) onAbort()
  })
}

export function createRotatingFetch(
  accounts: GoAccount[],
  lastIndex: number,
  baseFetch?: FetchFn,
  options: RotatingFetchOptions = {},
): { fetch: FetchFn; state: RotatingFetchState } {
  const useFetch = baseFetch ?? globalThis.fetch
  const pool = createAccountPool(accounts, lastIndex, {
    logger: options.logger,
    onStickyChange: options.onStickyChange,
    now: options.now,
    fetch: useFetch,
  })
  const { state, logger, now } = pool
  const inspectionTimeoutMs = options.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS
  const wait = options.wait ?? waitForCooldown
  const {
    isAvailable,
    isPrimary,
    nextAvailable,
    firstAvailable,
    earliestCooldown,
    probeCandidate,
    isStillAdvisoryEligible,
    selectAdvisoryPrimary,
  } = pool

  const fetch: FetchFn = async (input, init) => {
    const currentRequestGeneration = pool.startRequest()
    if (input instanceof Request && (input.bodyUsed || input.body?.locked)) {
      throw new TypeError("Cannot replay a consumed or locked Request")
    }
    const template = new Request(input, init)
    if (template.signal.aborted) throw callerAbortError(template.signal)
    const attempted = new Set<number>()
    let usageConsulted = false
    let advisoryOrigin: Candidate | null = null
    let selected = firstAvailable(now())
    let initialProbe = false

    const consultIfOverage = async (candidate: Candidate) => {
      if (isPrimary(candidate.index) || usageConsulted) {
        return { account: candidate.account, index: candidate.index, advisory: false as const }
      }
      usageConsulted = true
      const recovered = await selectAdvisoryPrimary(candidate.index, attempted, template.signal)
      if (!recovered) return { account: candidate.account, index: candidate.index, advisory: false as const }
      if (recovered.advisory) advisoryOrigin = candidate
      return recovered
    }

    const consultAfterResponse = async (candidate: Candidate, response: Response) => {
      try {
        return await consultIfOverage(candidate)
      } catch (error) {
        discardResponse(response)
        throw error
      }
    }

    const isReadyToAttempt = (
      index: number,
      isAdvisory: boolean,
      generation: number | undefined,
    ) => {
      if (isAdvisory) {
        return generation !== undefined && isStillAdvisoryEligible(index, generation, attempted)
      }
      if (initialProbe && attempted.size === 0) return accounts[index]?.enabled === true
      return !attempted.has(index) && isAvailable(index, now())
    }

    while (!selected) {
      const currentTime = now()
      const cooldownUntil = earliestCooldown()
      if (cooldownUntil !== undefined) {
        await wait(Math.max(0, cooldownUntil - currentTime), template.signal)
        selected = firstAvailable(now())
        continue
      }
      selected = probeCandidate()
      if (!selected) throw new Error("No enabled Go accounts")
      initialProbe = true
      logger("warn", "all candidates unavailable", {
        label: labelFor(accounts, selected.index),
        index: selected.index,
        class: "availability",
        reason: "probe_sticky",
      })
    }

    const resolved = await consultIfOverage(selected)
    let current: Candidate = { account: resolved.account, index: resolved.index }
    let advisory = resolved.advisory
    let capturedGeneration = resolved.advisory ? resolved.generation : undefined

    const resumeAfterAdvisory = () => {
      const origin = advisoryOrigin
      advisoryOrigin = null
      advisory = false
      capturedGeneration = undefined
      if (origin && !attempted.has(origin.index) && isAvailable(origin.index, now())) {
        return origin
      }
      return nextAvailable(current.index, attempted, now())
    }

    let lastResponse: Response | undefined
    const keepResponse = (response: Response) => {
      if (lastResponse && lastResponse !== response) discardResponse(lastResponse)
      lastResponse = response
    }
    const discardLastResponse = () => {
      if (!lastResponse) return
      discardResponse(lastResponse)
      lastResponse = undefined
    }

    let replacementClass = "availability"
    let replacementReason: RotationReason | PreferenceReason | "prior_penalty" = "prior_penalty"
    if (
      current.index !== state.activeIndex
      && !isPrimary(state.activeIndex)
      && isPrimary(current.index)
    ) {
      replacementClass = "preference"
      replacementReason = "preference_demotion"
    }

    while (true) {
      if (template.signal.aborted) {
        discardLastResponse()
        throw callerAbortError(template.signal)
      }
      if (!isReadyToAttempt(current.index, advisory, capturedGeneration)) {
        try {
          let next: Candidate | null = advisory
            ? resumeAfterAdvisory()
            : nextAvailable(current.index, attempted, now())
          if (next && !isPrimary(next.index) && !usageConsulted) {
            const recovered = await consultIfOverage(next)
            current = { account: recovered.account, index: recovered.index }
            advisory = recovered.advisory
            capturedGeneration = recovered.advisory ? recovered.generation : undefined
            continue
          }
          if (next) {
            current = next
            continue
          }
          const currentTime = now()
          const cooldownUntil = earliestCooldown()
          if (cooldownUntil !== undefined) {
            await wait(Math.max(0, cooldownUntil - currentTime), template.signal)
            const recovered = firstAvailable(now())
            if (recovered) {
              attempted.clear()
              const consulted = await consultIfOverage(recovered)
              current = { account: consulted.account, index: consulted.index }
              advisory = consulted.advisory
              capturedGeneration = consulted.advisory ? consulted.generation : undefined
            }
            continue
          }
          if (lastResponse) return lastResponse
          throw new Error("No enabled Go accounts")
        } catch (error) {
          discardLastResponse()
          throw error
        }
      }

      if (template.signal.aborted) {
        discardLastResponse()
        throw callerAbortError(template.signal)
      }
      discardLastResponse()
      attempted.add(current.index)
      const attemptGeneration = pool.availabilityGeneration(current.index)
      const attempt = template.clone()
      const headers = new Headers(attempt.headers)
      headers.set("Authorization", `Bearer ${current.account.apiKey}`)
      const request = new Request(attempt, {
        headers,
      })

      let response: Response
      try {
        response = await useFetch(request)
      } catch (error) {
        if (advisory && !template.signal.aborted) {
          const overage = resumeAfterAdvisory()
          if (overage) {
            current = overage
            continue
          }
        }
        throw error
      }
      let classification: ResponseClassification | null
      try {
        classification = await classifyResponse(
          response,
          inspectionTimeoutMs,
          now,
          template.signal,
        )
      } catch (error) {
        discardResponse(response)
        throw error
      }
      if (advisory && template.signal.aborted) {
        discardResponse(response)
        throw callerAbortError(template.signal)
      }

      if (!classification) {
        if (response.ok) {
          pool.settleSuccess({
            index: current.index,
            account: current.account,
            generation: attemptGeneration,
            requestGeneration: currentRequestGeneration,
          }, {
            status: response.status,
            class: replacementClass,
            reason: replacementReason,
          })
          return response
        }
        if (response.status === 429) {
          logger("warn", "credential rotation suppressed", {
            label: labelFor(accounts, current.index),
            index: current.index,
            status: response.status,
            class: "unknown",
            reason: "unclassified_429",
          })
        }
        if (advisory) {
          const overage = resumeAfterAdvisory()
          if (overage) {
            keepResponse(response)
            current = overage
            continue
          }
        }
        return response
      }

      if (classification.class === "overload") {
        logger("warn", "credential rotation suppressed", {
          label: labelFor(accounts, current.index),
          index: current.index,
          status: response.status,
          class: classification.class,
          reason: classification.reason,
        })
        if (advisory) {
          const overage = resumeAfterAdvisory()
          if (overage) {
            keepResponse(response)
            current = overage
            continue
          }
        }
        return response
      }

      const safeClassification = classification.class === "quota"
        ? {
            class: classification.class,
            reason: classification.reason,
            cooldownSource: classification.cooldownSource,
            cooldownMs: classification.cooldownMs,
          }
        : { class: classification.class, reason: classification.reason }

      pool.settlePenalty({
        index: current.index,
        account: current.account,
        generation: attemptGeneration,
        requestGeneration: currentRequestGeneration,
      }, classification)

      let next: Candidate | null
      if (advisory) {
        next = resumeAfterAdvisory()
      } else {
        next = nextAvailable(current.index, attempted, now())
        if (next) {
          const recovered = await consultAfterResponse(next, response)
          next = { account: recovered.account, index: recovered.index }
          advisory = recovered.advisory
          capturedGeneration = recovered.advisory ? recovered.generation : undefined
        }
      }
      if (!next) {
        logger("warn", "all candidates attempted", {
          label: labelFor(accounts, current.index),
          index: current.index,
          status: response.status,
          ...safeClassification,
        })
        let waited = false
        while (!next) {
          const currentTime = now()
          const candidate = firstAvailable(currentTime)
          if (candidate && (waited || !attempted.has(candidate.index))) {
            if (waited) attempted.clear()
            next = candidate
            const recovered = await consultAfterResponse(next, response)
            next = { account: recovered.account, index: recovered.index }
            advisory = recovered.advisory
            capturedGeneration = recovered.advisory ? recovered.generation : undefined
            break
          }
          const cooldownUntil = earliestCooldown()
          if (cooldownUntil === undefined) return response
          try {
            await wait(Math.max(0, cooldownUntil - currentTime), template.signal)
          } catch (error) {
            discardResponse(response)
            throw error
          }
          waited = true
        }
      }

      logger("warn", "credential rotation", {
        fromLabel: labelFor(accounts, current.index),
        fromIndex: current.index,
        toLabel: labelFor(accounts, next.index),
        toIndex: next.index,
        status: response.status,
        ...safeClassification,
      })
      keepResponse(response)
      replacementClass = classification.class
      replacementReason = classification.reason
      current = next
    }

  }

  return { fetch, state }
}
