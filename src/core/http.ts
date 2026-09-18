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
    const headers: Record<string, string> = { "user-agent": opts.userAgent ?? "social-cli/2.0 (+https://github.com/isaacrowntree/claude-social-skills)", ...(await opts.headers?.()), ...init.headers }
    let body: BodyInit | undefined
    if (init.form) {
      headers["content-type"] ??= "application/x-www-form-urlencoded"
      body = new URLSearchParams(Object.entries(init.form).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
    } else if (init.body instanceof FormData || typeof init.body === "string" || init.body instanceof Uint8Array || init.body instanceof Blob) {
      body = init.body as BodyInit
    } else if (init.body !== undefined) {
      headers["content-type"] ??= "application/json"
      body = JSON.stringify(init.body)
    }
    if (dryRun.enabled && method !== "GET" && method !== "HEAD") {
      console.error(`[dry-run] ${method} ${url}${body && typeof body === "string" ? `\n${body.slice(0, 1000)}` : ""}`)
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
      const text = await res.text()
      if (!res.ok) throw new ApiError(res.status, text, res.url, init.method ?? "GET")
      if (init.raw) return text as unknown as T
      if (!text) return undefined as unknown as T
      try { return JSON.parse(text) as T } catch { return text as unknown as T }
    },
    url: (path: string, query?: RequestInit2["query"]) => buildUrl(opts.baseUrl, path, query),
  }
}
export type Http = ReturnType<typeof makeHttp>
