/**
 * YouTube Data API v3. Spec: Google Discovery document
 * https://youtube.googleapis.com/$discovery/rest?version=v3 (not OpenAPI; the
 * `googleapis` package is generated from it upstream, so no types are generated here).
 *
 * Auth: Google OAuth 2 "installed app" flow with PKCE and a loopback redirect
 * (https://developers.google.com/identity/protocols/oauth2/native-app). Google
 * requires plain http on 127.0.0.1 for loopback, and the port may be dynamic, so
 * the callback is served by Bun.serve on a random port. Tokens live in state.json
 * and are refreshed in http() when expired. Needs GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET from a "Desktop app" OAuth client in Google Cloud Console
 * (Desktop clients get a secret that is not treated as confidential; Google still
 * requires it on the token endpoint for this client type).
 *
 * Uploads use the resumable protocol
 * (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
 * with plain HTTP: `googleapis` only implements multipart/media uploads.
 */
import type { Command } from "commander"
import { createHash, randomBytes } from "node:crypto"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, ApiError, dryRun, CALLBACK_PAGE, stopCallbackServer, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"
import { Generated, registerGenerated } from "../../core/openapi.ts"

/** Mutable so unit tests can point every leg at a local fake. */
export const endpoints = {
  api: "https://www.googleapis.com/youtube/v3",
  upload: "https://www.googleapis.com/upload/youtube/v3",
  token: "https://oauth2.googleapis.com/token",
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
}
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
]
const CRED_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
const HINT = "Create an OAuth client of type \"Desktop app\" at https://console.cloud.google.com/apis/credentials with the YouTube Data API v3 enabled, then `social auth login youtube`."

interface Tokens { access_token: string; refresh_token: string; expires_at: number }

async function clientEnv() { return config.require(CRED_KEYS, HINT) }

/**
 * Token endpoint (https://developers.google.com/identity/protocols/oauth2/native-app#exchange-authorization-code).
 * Errors come back as {"error":"invalid_grant","error_description":"..."}; verified live 2026-09-18 that an unknown
 * client is rejected first with HTTP 401 {"error":"invalid_client"} before the code is even looked at.
 */
async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const e = await clientEnv()
  const http = makeHttp({ baseUrl: endpoints.token })
  const r = await http.request<any>({ method: "POST", path: endpoints.token, form: { client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET, ...form } })
  const prev = (config.readState<any>().youtube_tokens ?? {}) as Partial<Tokens>
  const t: Tokens = { access_token: r.access_token, refresh_token: r.refresh_token ?? prev.refresh_token!, expires_at: Date.now() + (r.expires_in ?? 3600) * 1000 }
  config.writeState({ youtube_tokens: t })
  return t
}

function storedTokens(): Tokens {
  const t = config.readState<any>().youtube_tokens as Tokens | undefined
  if (!t?.access_token) throw new Error("No YouTube tokens stored. Run `social auth login youtube` (needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).")
  return t
}

async function accessToken(force = false): Promise<string> {
  let t = storedTokens()
  if (force || Date.now() > t.expires_at - 60_000) {
    if (!t.refresh_token) throw new Error("YouTube access token expired and no refresh token stored; run `social auth login youtube` again.")
    t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token })
  }
  return t.access_token
}

async function authed(baseUrl: string): Promise<Http> {
  storedTokens() // fail fast with the sign-in hint; the bearer itself is resolved (and refreshed) per request
  return makeHttp({
    baseUrl,
    headers: async () => ({ authorization: `Bearer ${await accessToken()}`, accept: "application/json" }),
    onUnauthorized: async () => { try { await accessToken(true); return true } catch { return false } },
  })
}
async function api(): Promise<Http> { return authed(endpoints.api) }

function b64url(b: Buffer) { return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }

/** https://developers.google.com/identity/protocols/oauth2/native-app (loopback IP address flow, PKCE S256). */
async function login(): Promise<void> {
  const e = await clientEnv()
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const state = b64url(randomBytes(16))
  let resolveCode!: (c: string) => void, rejectCode!: (e: Error) => void
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej })
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url)
      if (u.searchParams.get("state") !== state) return new Response("<h1>State mismatch; try again.</h1>", { status: 400, headers: CALLBACK_PAGE })
      const c = u.searchParams.get("code")
      if (c) { resolveCode(c); return new Response("<h1>Authorised. You can close this tab.</h1>", { headers: CALLBACK_PAGE }) }
      rejectCode(new Error(`Google authorisation failed: ${u.searchParams.get("error") ?? "unknown"}`))
      return new Response("<h1>Authorisation failed.</h1>", { status: 400, headers: CALLBACK_PAGE })
    },
  })
  const redirect = `http://127.0.0.1:${server.port}/`
  const q = new URLSearchParams({ client_id: e.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "), code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" })
  const url = `${endpoints.authorize}?${q}`
  note(`Opening the browser for Google authorisation.\n${url}`)
  Bun.spawn(["open", url])
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timed out waiting for the Google callback")), 180_000) })
    const c = await Promise.race([code, timeout]).finally(() => clearTimeout(timer))
    const t = await tokenRequest({ grant_type: "authorization_code", code: c, code_verifier: verifier, redirect_uri: redirect })
    note(`YouTube OAuth stored. Access token good for ${Math.round((t.expires_at - Date.now()) / 60000)} min; refresh token kept for renewals.`)
  } finally { stopCallbackServer(server) }
}

// ---------- reads ----------

/** https://developers.google.com/youtube/v3/docs/channels/list */
async function myChannel(): Promise<any> {
  const r = await (await api()).request<any>({ path: "channels", query: { part: "snippet,statistics,contentDetails", mine: true } })
  const c = r.items?.[0]
  if (!c) throw new Error("This Google account has no YouTube channel.")
  return c
}

const videoUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`
const fmtVideo = (v: any) => `${v.snippet?.title}\n${v.snippet?.channelTitle}  ${v.snippet?.publishedAt?.slice(0, 10)}  views ${v.statistics?.viewCount ?? "?"}  likes ${v.statistics?.likeCount ?? "?"}  ${v.status?.privacyStatus ?? ""}\n${videoUrl(v.id)}`

// ---------- upload ----------

/**
 * Resumable upload (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).
 * Step 1 needs the session URI from the Location header, which makeHttp's request() does not surface,
 * so that one call uses fetch with the same auth, dry-run and ApiError semantics. Step 2 streams the
 * file through makeHttp; on a 5xx that survives its retries we ask the session where it got to
 * (308 + Range header, again needs headers) and PUT the remainder with Content-Range.
 */
export async function uploadVideo(file: string, meta: { title: string; description?: string; privacy?: string; tags?: string[] }): Promise<any> {
  const f = Bun.file(file)
  if (!(await f.exists())) throw new Error(`file not found: ${file}`)
  const mime = f.type && f.type !== "application/octet-stream" ? f.type.split(";")[0] : "video/*"
  const body = { snippet: { title: meta.title, description: meta.description ?? "", tags: meta.tags }, status: { privacyStatus: meta.privacy ?? "private" } }
  const initUrl = `${endpoints.upload}/videos?uploadType=resumable&part=snippet,status`
  if (dryRun.enabled) { console.error(`[dry-run] POST ${initUrl}\n${JSON.stringify(body)}\n[dry-run] PUT <session uri> ${f.size} bytes ${mime}`); return { dry_run: true, method: "POST", url: initUrl } }
  const headers = { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(f.size), "x-upload-content-type": mime }
  const init = await fetch(initUrl, { method: "POST", headers, body: JSON.stringify(body) })
  if (!init.ok) throw new ApiError(init.status, await init.text(), initUrl, "POST")
  const session = init.headers.get("location")
  if (!session) throw new Error("YouTube did not return a resumable session URI (no Location header)")
  const http = await authed(endpoints.upload)
  try {
    return await http.request<any>({ method: "PUT", path: session, body: f, headers: { "content-type": mime } })
  } catch (err) {
    if (!(err instanceof ApiError) || err.status < 500) throw err
    const st = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${await accessToken()}`, "content-range": `bytes */${f.size}` } })
    if (st.status !== 308) { if (st.ok) return st.json(); throw new ApiError(st.status, await st.text(), session, "PUT") }
    const from = Number(st.headers.get("range")?.match(/-(\d+)$/)?.[1] ?? -1) + 1
    return http.request<any>({ method: "PUT", path: session, body: f.slice(from), headers: { "content-type": mime, "content-range": `bytes ${from}-${f.size - 1}/${f.size}` } })
  }
}

// ---------- platform ----------

/**
 * Every operation in Google's YouTube Data API Discovery document, generated: `social youtube ops | describe | call` send them
 * through the same authenticated client as the commands below.
 */
export const generated = new Generated({
  name: "youtube", indexFile: new URL("./ops.gen.json", import.meta.url).pathname,
  client: async () => api(),
})

export const youtube: Platform = {
  name: "youtube",
  summary: "YouTube Data API v3: your channel, uploads, video details, comments, upload and delete videos",
  spec: { kind: "discovery", source: "https://youtube.googleapis.com/$discovery/rest?version=v3" },
  credentials: { keys: CRED_KEYS, hint: HINT, docsUrl: "https://developers.google.com/youtube/v3/docs" },
  http: api,
  auth: login,
  async whoami() {
    const c = await myChannel()
    return { id: c.id, title: c.snippet?.title, handle: c.snippet?.customUrl, subscribers: c.statistics?.subscriberCount }
  },
  register(cmd: Command) {
    registerGenerated(cmd, generated)
    cmd.command("me").description("your channel (channels.list mine=true)").option("--json").option("--jq <e>").action(async (o) => {
      await emit(await myChannel(), o, (c) => `${c.snippet?.title} (${c.id})  ${c.snippet?.customUrl ?? ""}\nsubscribers ${c.statistics?.subscriberCount}  videos ${c.statistics?.videoCount}  views ${c.statistics?.viewCount}`)
    })

    // Uploads are the channel's "uploads" playlist: https://developers.google.com/youtube/v3/docs/playlistItems/list
    cmd.command("videos").description("your uploads, newest first (playlistItems.list on the uploads playlist)").option("-n, --max <n>", "count (1-50)", "10").option("--page <token>", "pageToken from a previous call").option("--json").option("--jq <e>")
      .action(async (o) => {
        const playlistId = (await myChannel()).contentDetails?.relatedPlaylists?.uploads
        if (!playlistId) throw new Error("channel has no uploads playlist")
        const r = await (await api()).request<any>({ path: "playlistItems", query: { part: "snippet,contentDetails,status", playlistId, maxResults: Math.min(50, Math.max(1, Number(o.max))), pageToken: o.page } })
        await emit(r, o, (d) => ((d.items ?? []).map((i: any) => `${i.snippet?.resourceId?.videoId}  ${i.snippet?.publishedAt?.slice(0, 10)}  ${(i.status?.privacyStatus ?? "").padEnd(8)}  ${i.snippet?.title}`).join("\n") || "(no videos)") + (d.nextPageToken ? `\nnext: --page ${d.nextPageToken}` : ""))
      })

    // https://developers.google.com/youtube/v3/docs/videos/list
    cmd.command("video <id>").description("one video with stats (videos.list)").option("--json").option("--jq <e>").action(async (id, o) => {
      const r = await (await api()).request<any>({ path: "videos", query: { part: "snippet,statistics,status,contentDetails", id } })
      if (!r.items?.length) throw new Error(`no video with id ${id}`)
      await emit(r.items[0], o, fmtVideo)
    })

    // https://developers.google.com/youtube/v3/docs/videos/insert (scope youtube.upload)
    cmd.command("upload <file>").description("upload a video (resumable videos.insert); private unless --privacy says otherwise")
      .requiredOption("--title <t>").option("--description <text>", "", "").option("--privacy <p>", "public | private | unlisted", "private").option("--tags <tags...>").option("--json").option("--jq <e>")
      .action(async (file, o) => {
        if (!["public", "private", "unlisted"].includes(o.privacy)) throw new Error("--privacy must be public, private or unlisted")
        const r = await uploadVideo(file, { title: o.title, description: o.description, privacy: o.privacy, tags: o.tags })
        await emit(r, o, (d) => d.dry_run ? "(dry run)" : `${d.id}  ${d.status?.privacyStatus}  ${d.status?.uploadStatus}\n${videoUrl(d.id)}`)
      })

    // https://developers.google.com/youtube/v3/docs/commentThreads/list
    cmd.command("comments <videoId>").description("top-level comments on a video (commentThreads.list)").option("-n, --max <n>", "count (1-100)", "20").option("--order <o>", "time | relevance", "time").option("--page <token>").option("--json").option("--jq <e>")
      .action(async (videoId, o) => {
        const r = await (await api()).request<any>({ path: "commentThreads", query: { part: "snippet", videoId, maxResults: Math.min(100, Math.max(1, Number(o.max))), order: o.order, textFormat: "plainText", pageToken: o.page } })
        await emit(r, o, (d) => ((d.items ?? []).map((t: any) => { const s = t.snippet?.topLevelComment?.snippet ?? {}; return `${t.id}  ${s.publishedAt?.slice(0, 10)}  ${s.authorDisplayName}: ${String(s.textDisplay ?? "").replace(/\n/g, " ").slice(0, 120)}${t.snippet?.totalReplyCount ? `  (+${t.snippet.totalReplyCount} replies)` : ""}` }).join("\n") || "(no comments)") + (d.nextPageToken ? `\nnext: --page ${d.nextPageToken}` : ""))
      })

    // https://developers.google.com/youtube/v3/docs/videos/delete — 204 with an empty body on success.
    cmd.command("delete <videoId>").description("delete one of your videos (videos.delete, 50 quota units)").option("--json").action(async (videoId, o) => {
      const r = await (await api()).request<any>({ method: "DELETE", path: "videos", query: { id: videoId } })
      await emit(r ?? { deleted: videoId }, o, (d) => d?.dry_run ? "(dry run)" : `deleted ${videoId}`)
    })
  },
}
