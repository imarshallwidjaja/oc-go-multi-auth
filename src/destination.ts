// Where a request is going, compared with where OpenCode Go is configured to go.
// A pool key may only be written onto a request whose destination lies under a
// base URL the host's own Go configuration names.

/** A URL reduced to what decides who receives a credential. */
export interface Endpoint {
  /** `scheme//host[:port]`, with WebSocket schemes folded onto their HTTP equivalents. */
  readonly origin: string
  /** Path without trailing slashes; empty for the root. */
  readonly path: string
}

// ws and wss are the WebSocket forms of http and https, and only of those: a
// request that changes the security level of its base is a different destination.
const EQUIVALENT_SCHEME: Record<string, string> = { "http:": "http:", "https:": "https:", "ws:": "http:", "wss:": "https:" }

/** True for a configured value that still holds an unexpanded `${...}` variable. */
export function isUnresolved(value: string) {
  return value.includes("${")
}

/** Returns undefined for anything that is not a plain http(s) or ws(s) URL. Query and fragment never count. */
export function parseEndpoint(value: string): Endpoint | undefined {
  if (isUnresolved(value)) return
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }
  const scheme = EQUIVALENT_SCHEME[url.protocol]
  if (!scheme) return
  return { origin: `${scheme}//${url.host}`, path: url.pathname.replace(/\/+$/, "") }
}

/** Same origin, and a path equal to the base's or below it on a segment boundary. */
export function endpointWithin(base: Endpoint, request: Endpoint) {
  return request.origin === base.origin && (request.path === base.path || request.path.startsWith(`${base.path}/`))
}

/** Origin of a URL for diagnostics: never a path, query, or credentials. */
export function originOf(value: string) {
  try {
    const url = new URL(value)
    return url.host ? `${url.protocol}//${url.host}` : undefined
  } catch {
    return
  }
}

/** The `baseURL` of a provider, model, or variant `settings` object, when it is a string. */
export function baseURLOf(settings: unknown) {
  const value = typeof settings === "object" && settings !== null ? (settings as { baseURL?: unknown }).baseURL : undefined
  return typeof value === "string" && value !== "" ? value : undefined
}
