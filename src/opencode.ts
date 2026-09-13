export const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
export const NATIVE_PACKAGE_SETTING = "ocGoMultiAuthNativePackage"

export const V2_NATIVE_PACKAGE_IDS = [
  "aisdk:@ai-sdk/anthropic",
  "aisdk:@ai-sdk/openai",
  "aisdk:@ai-sdk/openai-compatible",
] as const

export type V2NativePackage = typeof V2_NATIVE_PACKAGE_IDS[number]
