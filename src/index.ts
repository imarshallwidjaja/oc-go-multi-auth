import type { Plugin as V2Plugin } from "@opencode/plugin"
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import { initializeRotation } from "./runtime.js"
import { addGoAccountMethod } from "./v1-connect.js"
import { PROVIDER_ID, setupV2 } from "./v2.js"

// OpenCode 1 calls server(); OpenCode 2 calls setup(). Each uses only its own API.
const server: V1Plugin = async () => ({
  auth: {
    provider: PROVIDER_ID,
    // The host calls the loader only when opencode-go already has a stored key,
    // so the loader never writes credentials.
    async loader() {
      const options = initializeRotation()
      if (!options) return {}
      return { apiKey: "", fetch: options.fetch }
    },
    // The stock single-key method stays first; Add Go Account also adds the key to the pool.
    methods: [{ type: "api", label: "Go API key" }, addGoAccountMethod],
  },
})

const plugin = {
  id: "oc-go-multi-auth",
  setup: setupV2,
} satisfies V2Plugin.Plugin

interface RootPlugin {
  readonly id: string
  readonly setup: (context: never) => Promise<unknown>
  readonly server: V1Plugin
}

export default { ...plugin, server } as RootPlugin
