import type { AuthHook } from "@opencode-ai/plugin"
import { addAccount } from "./accounts.js"
import { log } from "./logger.js"
import { parseAccountRole, type AccountRole } from "./types.js"

type OAuthMethod = Extract<AuthHook["methods"][number], { type: "oauth" }>
type ConnectResult = { type: "success"; key: string } | { type: "failed" }
type AddRequest = { apiKey: string; label: string; role: AccountRole }

export const ADD_GO_ACCOUNT_LABEL = "Add Go Account"
const KEY_PAGE = "https://opencode.ai/auth"

// The host web UI shows the text after the last colon as a confirmation code, so
// every instruction here is colon-free.
const MISSING_KEY = "Enter a Go API key"
const MISSING_LABEL = "Enter an account label"
const INVALID_ROLE = "Choose primary or overage_fallback as the account role"

function parseRequest(inputs: Record<string, string> | undefined): AddRequest | string {
  const apiKey = typeof inputs?.apiKey === "string" ? inputs.apiKey.trim() : ""
  if (!apiKey) return MISSING_KEY
  const label = typeof inputs?.label === "string" ? inputs.label.trim() : ""
  if (!label) return MISSING_LABEL
  const role = inputs?.role === undefined ? "primary" : parseAccountRole(inputs.role)
  if (!role) return INVALID_ROLE
  return { apiKey, label, role }
}

async function save(request: AddRequest): Promise<ConnectResult> {
  try {
    await addAccount(request)
    return { type: "success", key: request.apiKey }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log("error", "add go account failed", { error: message.split(request.apiKey).join("[redacted]") })
    return { type: "failed" }
  }
}

/**
 * OpenCode 1 provider-connect method that adds a pool account and connects
 * OpenCode Go with the same key. The host calls plugin code over HTTP only for
 * OAuth-shaped methods, so this uses the OAuth transport with an immediate
 * `auto` callback that returns a real API key, which the host stores as its
 * opencode-go credential.
 *
 * authorize() only validates. The pool is written in the callback, at most once
 * per returned authorization: repeated or concurrent callbacks share one save,
 * and an authorization the host replaces before its callback runs writes nothing.
 */
export const addGoAccountMethod: OAuthMethod = {
  type: "oauth",
  label: ADD_GO_ACCOUNT_LABEL,
  prompts: [
    { type: "text", key: "apiKey", message: "Go API key", validate: (value) => value.trim() ? undefined : MISSING_KEY },
    { type: "text", key: "label", message: "Account label", validate: (value) => value.trim() ? undefined : MISSING_LABEL },
    {
      type: "select",
      key: "role",
      message: "Account role",
      options: [
        { label: "primary", value: "primary", hint: "Used first" },
        { label: "overage_fallback", value: "overage_fallback", hint: "Used after every primary is unavailable" },
      ],
    },
  ],
  async authorize(inputs) {
    const request = parseRequest(inputs)
    if (typeof request === "string") {
      return { url: KEY_PAGE, method: "auto", instructions: request, callback: async () => ({ type: "failed" }) }
    }
    let saved: Promise<ConnectResult> | undefined
    return {
      url: KEY_PAGE,
      method: "auto",
      instructions: "Adds this key to the Go account pool and connects OpenCode Go with it",
      callback: () => saved ??= save(request),
    }
  },
}
