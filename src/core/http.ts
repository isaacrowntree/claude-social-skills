/**
 * One HTTP layer for every platform: retries, rate-limit waits, typed errors,
 * and --dry-run. Every platform client is a thin config over this.
 */
export interface HttpOptions {
  baseUrl: string
  headers?: () => Promise<Record<string, string>> | Record<string, string>
  /** Called for a 401; return true if the caller refreshed credentials and the request may be retried once. */
  onUnauthorized?: () => Promise<boolean>
  userAgent?: string
  /** Refuse to send to any other host (the client's credentials are only for these). */
  allowHost?: (hostname: string) => boolean
}

export class ApiError extends Error {
  constructor(public status: number, public body: string, public url: string, public method: string) {
    super(`HTTP ${status} ${method} ${url}\n${body.slice(0, 2000)}`)
  }
  /** Best-effort JSON body. */
  get json(): unknown { try { return JSON.parse(this.body) } catch { return undefined } }
}

export class UnsafeToRetryError extends Error {}

export const dryRun = { enabled: false }

const RETRY_STATUSES = new Set([502, 503, 504])
const MAX_ATTEMPTS = 3
const BACKOFF_MS = [250, 1000]
const MAX_RATE_WAIT_MS = 90_000

export interface RequestInit2 {
  method?: string
  path: string
  query?: Record<string, string | number | boolean | undefined | (string | number)[]>
  body?: unknown
  form?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  raw?: boolean
  /** Resolve to { status, headers, body } instead of the body alone (for 201s that answer in a Location header). */
  full?: boolean
  /** Send even under --dry-run. Only for credential exchanges (token refresh), which change nothing remote. */
  noDryRun?: boolean
}

const SECRET_KEY = /token|secret|password|code_verifier|^code$|assertion/i

/** What --dry-run prints for a body: secrets masked, multipart parts and file sizes listed, GraphQL variables first. */
export function describeBody(body: BodyInit | undefined): string {
  if (body === undefined) return ""
  if (body instanceof FormData) return [...body.entries()].map(([k, v]) => typeof v === "string" ? `${k}=${v.slice(0, 200)}` : `${k}=<file ${(v as File).name} ${(v as File).size} bytes>`).join("\n")
  if (body instanceof Blob) return `<${body.size} bytes${body.type ? ` ${body.type}` : ""}>`
  if (body instanceof Uint8Array) return `<${body.byteLength} bytes>`
  const text = String(body)
  try {
    const mask = (x: any): any => Array.isArray(x) ? x.map(mask) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === "string" ? "***" : mask(v)])) : x
    const v = mask(JSON.parse(text))
    // A generated GraphQL document runs to kilobytes; the variables are the part worth reading.
    if (v && typeof v === "object" && "query" in v && "variables" in v) return `variables: ${JSON.stringify(v.variables, null, 2)}\nquery: ${String(v.query).slice(0, 600)}${String(v.query).length > 600 ? "…" : ""}`
    return JSON.stringify(v).slice(0, 4000)
  } catch {}
  if (/^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(text)) return text.split("&").map((kv) => { const [k] = kv.split("="); return SECRET_KEY.test(decodeURIComponent(k)) ? `${k}=***` : kv }).join("&")
  return text.replace(/<(eBayAuthToken)>[^<]*<\/\1>/g, "<$1>***</$1>").slice(0, 4000)
}

/** Text-like responses are decoded; anything else (PDF labels, gzip feeds, images) comes back as bytes. */
function isText(contentType: string | null): boolean {
  return !contentType || /json|text|xml|javascript|html|x-www-form-urlencoded|graphql/i.test(contentType)
}

export function buildUrl(base: string, path: string, query?: RequestInit2["query"]): string {
  const u = new URL(path.startsWith("http") ? path : `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`)
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)))
    else u.searchParams.set(k, String(v))
  }
  return u.toString()
}

export function makeHttp(opts: HttpOptions) {
  async function once(init: RequestInit2, attempt: number): Promise<Response> {
    const method = (init.method ?? (init.body || init.form ? "POST" : "GET")).toUpperCase()
    const url = buildUrl(opts.baseUrl, init.path, init.query)
    if (opts.allowHost && !opts.allowHost(new URL(url).hostname)) throw new Error(`refusing to send credentials to ${new URL(url).host}`)
    // Header names are case-insensitive: a caller's "Content-Type" must replace the default, not join it.
    const headers = new Headers({ "user-agent": opts.userAgent ?? "social-cli/2.0 (+https://github.com/isaacrowntree/claude-social-skills)" })
    for (const [k, v] of Object.entries({ ...(await opts.headers?.()), ...init.headers })) headers.set(k, v)
    let body: BodyInit | undefined
    if (init.form) {
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded")
      body = new URLSearchParams(Object.entries(init.form).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
    } else if (init.body instanceof FormData) {
      headers.delete("content-type") // fetch adds multipart/form-data with the boundary; any other value breaks the upload
      body = init.body
    } else if (typeof init.body === "string" || init.body instanceof Uint8Array || init.body instanceof Blob) {
      if (init.body instanceof Blob && init.body.type && !headers.has("content-type")) headers.set("content-type", init.body.type)
      body = init.body as BodyInit
    } else if (init.body !== undefined) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
      body = JSON.stringify(init.body)
    }
    if (dryRun.enabled && !init.noDryRun && method !== "GET" && method !== "HEAD") {
      const shown = describeBody(body)
      console.error(`[dry-run] ${method} ${url}${shown ? `\n${shown}` : ""}`)
      return new Response(JSON.stringify({ dry_run: true, method, url }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const res = await fetch(url, { method, headers, body })
    if (res.status === 429 || (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS)) {
      const idempotent = ["GET", "HEAD", "PUT", "DELETE"].includes(method)
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after") ?? res.headers.get("x-rate-limit-reset") ?? 0)
        const waitMs = ra > 1e9 ? Math.max(0, ra * 1000 - Date.now()) : ra * 1000 || 5000
        if (waitMs > MAX_RATE_WAIT_MS) return res
        if (attempt === 1) { await Bun.sleep(waitMs); return once(init, attempt + 1) }
        return res
      }
      if (!idempotent) return res
      await Bun.sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)])
      return once(init, attempt + 1)
    }
    return res
  }

  return {
    async request<T = unknown>(init: RequestInit2): Promise<T> {
      let res = await once(init, 1)
      if (res.status === 401 && opts.onUnauthorized && (await opts.onUnauthorized())) res = await once(init, 1)
      if (res.ok && !isText(res.headers.get("content-type"))) {
        const bytes = new Uint8Array(await res.arrayBuffer())
        return (init.full ? { status: res.status, headers: Object.fromEntries(res.headers), body: bytes } : bytes) as T
      }
      const text = await res.text()
      if (!res.ok) throw new ApiError(res.status, text, res.url, init.method ?? "GET")
      let body: unknown = text
      if (!init.raw) { if (!text) body = undefined; else try { body = JSON.parse(text) } catch {} }
      if (init.full) return { status: res.status, headers: Object.fromEntries(res.headers), body } as T
      return body as T
    },
    url: (path: string, query?: RequestInit2["query"]) => buildUrl(opts.baseUrl, path, query),
  }
}
export type Http = ReturnType<typeof makeHttp>

/**
 * Shut an OAuth callback server down without cutting off the page the browser is still
 * receiving. `stop(true)` drops open connections, so the browser showed no response after
 * "Agree" even though the code was captured; a graceful stop lets it finish, and the forced
 * stop after 2 s keeps a lingering keep-alive from holding the process open.
 */
export function stopCallbackServer(server: { stop(force?: boolean): unknown }): void {
  server.stop()
  setTimeout(() => server.stop(true), 2000).unref()
}

/** Headers for a callback page: close the connection so the graceful stop above is quick. */
export const CALLBACK_PAGE = { "content-type": "text/html", connection: "close" }
