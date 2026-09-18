/**
 * One Graph client for the three Meta platforms. Two hosts, one shape:
 *   graph.facebook.com  — Facebook Pages and Instagram (Facebook Login flavour)
 *   graph.threads.net   — Threads
 * Versions: Graph API changelog https://developers.facebook.com/docs/graph-api/changelog
 * (v26.0, released 2026-07-29, is the latest as of writing); Threads has only ever
 * published v1.0, https://developers.facebook.com/docs/threads/changelog.
 *
 * The token goes in `Authorization: Bearer`, not the query string, so it never lands
 * in an ApiError's URL. Verified live 2026-09-18: both hosts accept the header and
 * answer 401 {"error":{"code":190,...}} for a bad token (400 when it is in the query).
 * Every Graph error has the same body: {"error":{"message","type","code","fbtrace_id"}}.
 */
import { makeHttp, dryRun, type Http } from "../../core/http.ts"

/** One base per host. Tests point these at a local fake. */
export const GRAPH = {
  facebook: "https://graph.facebook.com/v26.0",
  threads: "https://graph.threads.net/v1.0",
}

export function graphHttp(baseUrl: string, token: string): Http {
  return makeHttp({ baseUrl, headers: () => ({ authorization: `Bearer ${token}` }) })
}

/**
 * Container → publish flows (Instagram, Threads) need the container to reach FINISHED
 * before `*_publish` succeeds. Instagram exposes `status_code`, Threads `status`; the
 * values are the same five: IN_PROGRESS, FINISHED, PUBLISHED, ERROR, EXPIRED.
 *   IG:      https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
 *   Threads: https://developers.facebook.com/docs/threads/troubleshooting
 * Returns immediately under --dry-run (there is no real container to poll).
 */
export async function waitForContainer(http: Http, id: string, field: "status_code" | "status", opts: { intervalMs: number; maxMs: number }): Promise<string> {
  if (dryRun.enabled) return "FINISHED"
  const deadline = Date.now() + opts.maxMs
  for (;;) {
    const r = await http.request<Record<string, string>>({ path: id, query: { fields: field === "status" ? "status,error_message" : "status_code,status" } })
    const s = r[field]
    if (s === "FINISHED" || s === "PUBLISHED") return s
    if (s === "ERROR" || s === "EXPIRED") throw new Error(`container ${id} ${s}: ${r.error_message ?? r.status ?? ""}`.trim())
    if (Date.now() >= deadline) throw new Error(`container ${id} still ${s ?? "unknown"} after ${opts.maxMs / 1000}s; publish it later with \`social api … ${id}\``)
    await Bun.sleep(opts.intervalMs)
  }
}
