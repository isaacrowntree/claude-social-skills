/**
 * Reddit Data API. No machine-readable spec; the live docs are https://www.reddit.com/dev/api
 * and the OAuth guide is https://github.com/reddit-archive/reddit/wiki/OAuth2.
 *
 * Two ways in, both needing an app from https://www.reddit.com/prefs/apps:
 *   script app, password grant  ← REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET + REDDIT_USERNAME +
 *     REDDIT_PASSWORD. No browser, no redirect server, but the account must have 2FA OFF and
 *     the app only ever sees its own developer accounts. The everyday path for a bot account.
 *   authorization-code grant     ← `social auth login reddit`. Opens the browser, catches the
 *     redirect on http://localhost:8765/callback (set that as the app's redirect uri), asks for
 *     duration=permanent so a refresh_token comes back. Works with 2FA on.
 * Access tokens last 1 hour; http() refreshes (refresh_token, or the password grant again).
 *
 * Every request carries a descriptive User-Agent (`social-cli/2.0 by u/<username>`): Reddit
 * "drastically" throttles generic ones and says it will block unidentified clients.
 * Since 11 Nov 2025 Reddit's Responsible Builder Policy also requires explicit approval for
 * any Data API use (request via https://support.reddithelp.com/hc/en-us/requests/new); an
 * app created at /prefs/apps without that approval may be throttled or blocked.
 */
import type { Command } from "commander"
import { randomBytes } from "node:crypto"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, ApiError, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"

// Overridable so unit tests can point at a local fake; production values are the documented hosts.
const API_BASE = () => process.env.REDDIT_API_BASE ?? "https://oauth.reddit.com"
const WWW_BASE = () => process.env.REDDIT_WWW_BASE ?? "https://www.reddit.com"
const REDIRECT_URI = "http://localhost:8765/callback"
const SCOPES = ["identity", "read", "submit", "edit", "privatemessages", "history", "mysubreddits", "save", "vote", "report"]
const APP_KEYS = ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]
const SCRIPT_KEYS = ["REDDIT_USERNAME", "REDDIT_PASSWORD"]
const APP_HINT = "Create an app at https://www.reddit.com/prefs/apps (type \"script\" for the password grant, or \"web app\" with redirect uri http://localhost:8765/callback for `social auth login reddit`). Reddit also requires access approval since Nov 2025: https://support.reddithelp.com/hc/en-us/requests/new"

interface Tokens { access_token: string; refresh_token?: string; expires_at: number; scope?: string; grant: "password" | "authorization_code"; username?: string }

function basic(id: string, secret: string) { return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") }
async function userAgent(): Promise<string> {
  const u = (await config.get("REDDIT_USERNAME")) ?? config.readState<any>().reddit_tokens?.username ?? "anonymous"
  return `social-cli/2.0 by u/${u}`
}

/**
 * POST https://www.reddit.com/api/v1/access_token with HTTP Basic client auth.
 * Docs: https://github.com/reddit-archive/reddit/wiki/OAuth2#retrieving-the-access-token
 * Live (2026-09-18): bad client credentials → 401 {"message": "Unauthorized", "error": 401};
 * a bad/used code or bad password → 200 {"error": "invalid_grant"}, which we turn into a throw.
 */
async function tokenRequest(form: Record<string, string>, grant: Tokens["grant"]): Promise<Tokens> {
  const e = await config.require(APP_KEYS, APP_HINT)
  const http = makeHttp({ baseUrl: WWW_BASE(), userAgent: await userAgent() })
  const r = await http.request<any>({ method: "POST", path: "api/v1/access_token", form, headers: { authorization: basic(e.REDDIT_CLIENT_ID, e.REDDIT_CLIENT_SECRET) } })
  if (r?.error) throw new ApiError(200, JSON.stringify(r), http.url("api/v1/access_token"), "POST")
  const prev = (config.readState<any>().reddit_tokens ?? {}) as Partial<Tokens>
  const t: Tokens = {
    access_token: r.access_token, refresh_token: r.refresh_token ?? prev.refresh_token,
    expires_at: Date.now() + (r.expires_in ?? 3600) * 1000, scope: r.scope, grant, username: prev.username ?? (await config.get("REDDIT_USERNAME")),
  }
  config.writeState({ reddit_tokens: t })
  return t
}

async function haveScriptCreds() { return (await Promise.all(SCRIPT_KEYS.map((k) => config.get(k)))).every(Boolean) }

/** Password grant for script apps. Docs: https://github.com/reddit-archive/reddit/wiki/OAuth2-Quick-Start-Example (2FA must be off). */
async function passwordGrant(): Promise<Tokens> {
  const c = await config.require([...APP_KEYS, ...SCRIPT_KEYS], APP_HINT + "\nThe password grant needs a \"script\" app and an account with 2FA disabled.")
  return tokenRequest({ grant_type: "password", username: c.REDDIT_USERNAME, password: c.REDDIT_PASSWORD }, "password")
}

async function accessToken(force = false): Promise<string> {
  const t = config.readState<any>().reddit_tokens as Tokens | undefined
  if (t && !force && Date.now() < t.expires_at - 60_000) return t.access_token
  if (t?.refresh_token) return (await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token }, t.grant)).access_token
  if (await haveScriptCreds()) return (await passwordGrant()).access_token
  throw new Error("No Reddit token. Either set REDDIT_USERNAME + REDDIT_PASSWORD (script app, 2FA off) or run `social auth login reddit`.\n" + APP_HINT)
}

/** Bearer client against https://oauth.reddit.com (never www.reddit.com for token'd calls). */
async function http(): Promise<Http> {
  return makeHttp({
    baseUrl: API_BASE(), userAgent: await userAgent(),
    headers: async () => ({ authorization: `Bearer ${await accessToken()}` }),
    onUnauthorized: async () => { await accessToken(true); return true },
  })
}

/** Authorization-code flow with duration=permanent. Docs: https://github.com/reddit-archive/reddit/wiki/OAuth2#authorization */
async function login(): Promise<void> {
  const e = await config.require(APP_KEYS, APP_HINT)
  const state = randomBytes(16).toString("hex")
  let resolveCode!: (c: string) => void, rejectCode!: (e: Error) => void
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej })
  const server = Bun.serve({
    port: 8765, hostname: "localhost",
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname !== "/callback") return new Response("not found", { status: 404 })
      const err = u.searchParams.get("error"), c = u.searchParams.get("code")
      if (err || !c) { rejectCode(new Error(`Reddit authorisation failed: ${err ?? "no code"}`)); return new Response(`<h1>Authorisation failed: ${err ?? "no code"}</h1>`, { status: 400, headers: { "content-type": "text/html" } }) }
      if (u.searchParams.get("state") !== state) { rejectCode(new Error("state mismatch on the Reddit callback")); return new Response("<h1>State mismatch</h1>", { status: 400, headers: { "content-type": "text/html" } }) }
      resolveCode(c)
      return new Response("<h1>Authorised. You can close this tab.</h1>", { headers: { "content-type": "text/html" } })
    },
  })
  const q = new URLSearchParams({ client_id: e.REDDIT_CLIENT_ID, response_type: "code", state, redirect_uri: REDIRECT_URI, duration: "permanent", scope: SCOPES.join(" ") })
  const url = `${WWW_BASE()}/api/v1/authorize?${q}`
  note(`Opening the browser for Reddit authorisation (the app's redirect uri must be ${REDIRECT_URI}).\n${url}`)
  Bun.spawn(["open", url])
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timed out waiting for the Reddit callback")), 180_000) })
    const c = await Promise.race([code, timeout]).finally(() => clearTimeout(timer))
    const t = await tokenRequest({ grant_type: "authorization_code", code: c, redirect_uri: REDIRECT_URI }, "authorization_code")
    const me = await (await http()).request<any>({ path: "api/v1/me" })
    config.writeState({ reddit_tokens: { ...t, username: me.name } })
    note(`Reddit OAuth stored for u/${me.name}. Access token good for ${Math.round((t.expires_at - Date.now()) / 60000)} min; refresh token ${t.refresh_token ? "present (permanent)" : "MISSING: the app did not grant duration=permanent"}.`)
  } finally { server.stop() }
}

// ---------- helpers ----------

/** api_type=json responses wrap errors as {json:{errors:[[code,message,field]]}}; surface them. */
function checkJsonErrors(r: any, url: string) {
  const errs = r?.json?.errors
  if (Array.isArray(errs) && errs.length) throw new ApiError(200, JSON.stringify(r), url, "POST")
}
const listing = (r: any) => (r?.data?.children ?? []).map((c: any) => c.data)
const fmtPost = (p: any) => `${p.name}  ${String(p.score).padStart(6)}  r/${p.subreddit}  ${p.title?.replace(/\n/g, " ").slice(0, 90)}`

// ---------- platform ----------

export const reddit: Platform = {
  name: "reddit",
  summary: "Reddit: post, comment, delete, inbox, home feed and subreddit listings, plus any Data API path",
  spec: { kind: "none", source: "https://www.reddit.com/dev/api (HTML only; no OpenAPI)" },
  credentials: { keys: APP_KEYS, optionalKeys: SCRIPT_KEYS, minimal: [APP_KEYS], hint: APP_HINT + " REDDIT_USERNAME/REDDIT_PASSWORD are only needed for the script (password) grant.", docsUrl: "https://www.reddit.com/dev/api" },
  http,
  auth: login,
  async whoami() {
    // GET /api/v1/me (scope identity): https://www.reddit.com/dev/api#GET_api_v1_me
    const r = await (await http()).request<any>({ path: "api/v1/me" })
    return { name: r.name, id: r.id, link_karma: r.link_karma, comment_karma: r.comment_karma }
  },
  register(cmd: Command) {
    cmd.command("me").description("the authenticated account (GET /api/v1/me)").option("--json").option("--jq <e>").action(async (o) => {
      await emit(await (await http()).request({ path: "api/v1/me" }), o, (d) => `u/${d.name} (${d.id})  link karma ${d.link_karma}  comment karma ${d.comment_karma}  since ${new Date(d.created_utc * 1000).toISOString().slice(0, 10)}`)
    })

    // POST /api/submit (scope submit): https://www.reddit.com/dev/api#POST_api_submit
    cmd.command("post <subreddit> <title>").description("submit a text or link post to a subreddit")
      .option("--text <markdown>", "self-post body (kind=self)").option("--url <url>", "link post (kind=link)")
      .option("--nsfw").option("--spoiler").option("--flair-id <id>").option("--resubmit", "allow a URL that was already posted to this subreddit")
      .option("--json").option("--jq <e>")
      .action(async (subreddit, title, o) => {
        if (!!o.text === !!o.url) throw new Error("pass exactly one of --text or --url")
        const h = await http()
        const r = await h.request<any>({ method: "POST", path: "api/submit", form: { api_type: "json", sr: subreddit.replace(/^r\//, ""), title, kind: o.url ? "link" : "self", text: o.text, url: o.url, nsfw: o.nsfw, spoiler: o.spoiler, flair_id: o.flairId, resubmit: o.resubmit } })
        checkJsonErrors(r, h.url("api/submit"))
        await emit(r, o, (d) => d.dry_run ? "(dry run)" : `${d.json?.data?.name}  ${d.json?.data?.url}`)
      })

    // POST /api/comment (scope submit, or privatemessages for a message reply): https://www.reddit.com/dev/api#POST_api_comment
    cmd.command("comment <thing_id> <text>").description("reply to a post (t3_…), comment (t1_…) or message (t4_…) by fullname").option("--json").option("--jq <e>")
      .action(async (thingId, text, o) => {
        const h = await http()
        const r = await h.request<any>({ method: "POST", path: "api/comment", form: { api_type: "json", thing_id: thingId, text } })
        checkJsonErrors(r, h.url("api/comment"))
        await emit(r, o, (d) => { if (d.dry_run) return "(dry run)"; const t = d.json?.data?.things?.[0]?.data; return t ? `${t.name}  https://www.reddit.com${t.permalink ?? ""}` : JSON.stringify(d) })
      })

    // POST /api/del (scope edit): https://www.reddit.com/dev/api#POST_api_del — returns {} on success.
    cmd.command("delete <thing_id>").description("delete your own post or comment by fullname").option("--json").action(async (thingId, o) => {
      const r = await (await http()).request<any>({ method: "POST", path: "api/del", form: { id: thingId } })
      await emit(r ?? {}, o, (d) => d.dry_run ? "(dry run)" : `deleted ${thingId}`)
    })

    // GET /message/unread | /message/inbox (scope privatemessages): https://www.reddit.com/dev/api#GET_message_{where}
    cmd.command("inbox").description("unread messages, comment replies and mentions").option("-n, --max <n>", "count (max 100)", "25").option("--all", "the whole inbox, not only unread").option("--json").option("--jq <e>")
      .action(async (o) => {
        const r = await (await http()).request<any>({ path: o.all ? "message/inbox" : "message/unread", query: { limit: Number(o.max), raw_json: 1 } })
        await emit(r, o, (d) => listing(d).map((m: any) => `${m.new ? "*" : " "} ${m.name}  ${String(m.author ?? "").padEnd(20)}  ${(m.subject ?? "").slice(0, 30).padEnd(30)}  ${(m.body ?? "").replace(/\n/g, " ").slice(0, 60)}`).join("\n") || "(nothing unread)")
      })

    // GET /hot (scope read): the signed-in front page. https://www.reddit.com/dev/api#GET_hot
    cmd.command("feed").description("your home feed (hot)").option("-n, --max <n>", "count (max 100)", "25").option("--json").option("--jq <e>").action(async (o) => {
      const r = await (await http()).request<any>({ path: "hot", query: { limit: Number(o.max), raw_json: 1 } })
      await emit(r, o, (d) => listing(d).map(fmtPost).join("\n") || "(empty feed)")
    })

    // GET /r/{subreddit}/{sort} (scope read): https://www.reddit.com/dev/api#GET_hot
    cmd.command("subreddit <name>").description("a subreddit's listing (hot by default)").option("-n, --max <n>", "count (max 100)", "25").option("--sort <s>", "hot | new | rising | top | controversial", "hot").option("--json").option("--jq <e>")
      .action(async (name, o) => {
        if (!["hot", "new", "rising", "top", "controversial"].includes(o.sort)) throw new Error("--sort must be hot, new, rising, top or controversial")
        const r = await (await http()).request<any>({ path: `r/${name.replace(/^r\//, "")}/${o.sort}`, query: { limit: Number(o.max), raw_json: 1 } })
        await emit(r, o, (d) => listing(d).map(fmtPost).join("\n") || "(no posts)")
      })
  },
}
