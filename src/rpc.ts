// Portable RPC contract for account management on OpenCode 2. Plain JSON Schema
// with type-only imports, so clients can load it without the plugin or a host.
import type { Rpc } from "@opencode/plugin/rpc"

const role = { type: "string", enum: ["primary", "overage_fallback"] } as const

const accountSummary = {
  type: "object",
  properties: {
    id: { type: "string" },
    number: { type: "integer" },
    label: { type: "string" },
    role,
    enabled: { type: "boolean" },
    keyHint: { type: "string" },
    lastUsed: { type: "boolean" },
  },
  required: ["id", "number", "label", "role", "enabled", "keyHint", "lastUsed"],
  additionalProperties: false,
} as const

const accountResult = {
  type: "object",
  properties: { account: accountSummary },
  required: ["account"],
  additionalProperties: false,
} as const

const accountRef = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
} as const

// Expected failures carry only a display-safe message.
const errors = {
  rejected: { type: "object", additionalProperties: false },
} as const

export const GoAccountsRpc = {
  id: "oc-go-multi-auth",
  methods: {
    list: {
      input: { type: "object" },
      output: {
        type: "object",
        properties: { accounts: { type: "array", items: accountSummary } },
        required: ["accounts"],
        additionalProperties: false,
      },
      errors,
    },
    add: {
      // Validated by the handler so a malformed key is never echoed in a schema error.
      input: { type: "object" },
      output: {
        type: "object",
        properties: {
          account: accountSummary,
          count: { type: "integer" },
          activation: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["already_connected", "activated", "unsupported", "failed"] },
              message: { type: "string" },
            },
            required: ["status"],
            additionalProperties: false,
          },
        },
        required: ["account", "count", "activation"],
        additionalProperties: false,
      },
      errors,
    },
    setRole: {
      input: { ...accountRef, properties: { ...accountRef.properties, role } , required: ["id", "role"] },
      output: accountResult,
      errors,
    },
    remove: {
      input: accountRef,
      output: accountResult,
      errors,
    },
    usage: {
      input: { type: "object" },
      output: {
        type: "object",
        properties: { rows: { type: "array", items: { type: "object" } } },
        required: ["rows"],
        additionalProperties: false,
      },
      errors,
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export type GoAccountsRpcDefinition = typeof GoAccountsRpc
