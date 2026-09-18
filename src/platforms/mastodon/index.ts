/**
 * Mastodon. One REST API per instance; the instance comes from MASTODON_INSTANCE
 * (host only, e.g. mastodon.social). Auth is a bearer access token, which never
 * expires: either MASTODON_ACCESS_TOKEN pasted from the web UI (Preferences →
 * Development → New application → copy "Your access token"), or `social auth login
 * mastodon`, which registers a client (POST /api/v1/apps) with the out-of-band
 * redirect urn:ietf:wg:oauth:2.0:oob, opens /oauth/authorize, and exchanges the
 * code the user pastes at /oauth/token. No redirect server, no refresh.
 *
 * Spec: community OpenAPI 3 at https://github.com/abraham/mastodon-openapi (types.gen.ts
 * is generated from it by `bun run gen`). Docs: https://docs.joinmastodon.org/methods/
 */
import type { Command } from "commander"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"
import type { paths } from "./types.gen.ts"

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never
type Status = Json<paths["/api/v1/statuses/{id}"]["get"]["responses"][200]>
type Account = Json<paths["/api/v1/accounts/lookup"]["get"]["responses"][200]>
type CredentialAccount = Json<paths["/api/v1/accounts/verify_credentials"]["get"]["responses"][200]>
type Notification = Json<paths["/api/v1/notifications"]["get"]["responses"][200]>[number]
type MediaAttachment = Json<paths["/api/v2/media"]["post"]["responses"][200]>
type CredentialApplication = Json<paths["/api/v1/apps"]["post"]["responses"][200]>
type CreateApp = Json<paths["/api/v1/apps"]["post"]["requestBody"]>
type Token = Json<paths["/oauth/token"]["post"]["responses"][200]>
type TokenRequest = Json<paths["/oauth/token"]["post"]["requestBody"]>

const OOB = "urn:ietf:wg:oauth:2.0:oob"
const SCOPES = "read write"
const KEYS = ["MASTODON_INSTANCE", "MASTODON_ACCESS_TOKEN"]
const HINT = "MASTODON_INSTANCE is your server's host (e.g. mastodon.social). Get MASTODON_ACCESS_TOKEN from Preferences → Development → New application (scopes read, write) on that server, or run `social auth login mastodon`."

/** https://<instance>, accepting a full URL for tests and non-TLS dev servers. */
async function baseUrl(): Promise<string> {
  const i = (await config.get("MASTODON_INSTANCE")) ?? "mastodon.social"
  return /^https?:\/\//.test(i) ? i.replace(/\/$/, "") : `https://${i}`
}

/** Unauthenticated client: instance info, public timelines, lookups, app registration. */
async function publicHttp(): Promise<Http> { return makeHttp({ baseUrl: await baseUrl() }) }

/** Authenticated client; every curated command and `social api mastodon` go through this. */
async function userHttp(): Promise<Http> {
  const { MASTODON_ACCESS_TOKEN } = await config.require(["MASTODON_ACCESS_TOKEN"], HINT)
  return makeHttp({ baseUrl: await baseUrl(), headers: () => ({ authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` }) })
}

// https://docs.joinmastodon.org/methods/apps/#create  (public; JSON body accepted, verified live)
export async function registerApp(http: Http, body: Partial<CreateApp> = {}): Promise<CredentialApplication> {
  return http.request<CredentialApplication>({ method: "POST", path: "api/v1/apps", body: { client_name: "social-cli", redirect_uris: [OOB], scopes: SCOPES, website: "https://github.com/isaacrowntree/claude-social-skills", ...body } satisfies CreateApp })
}

/**
 * https://docs.joinmastodon.org/methods/oauth/  Registers a client once per instance
 * (kept in state.json), opens the authorisation page, and exchanges the code the user
 * pastes for a non-expiring token, stored as MASTODON_ACCESS_TOKEN.
 */
async function login(): Promise<void> {
  const instance = (await config.get("MASTODON_INSTANCE")) ?? (typeof prompt === "function" ? prompt("Mastodon instance host (e.g. mastodon.social):")?.trim() : undefined)
  if (!instance) throw new Error("MASTODON_INSTANCE is required")
  if (!(await config.get("MASTODON_INSTANCE"))) note(`stored MASTODON_INSTANCE in ${await config.set("MASTODON_INSTANCE", instance) === "keyring" ? "the OS keyring" : config.ENV_FILE}`)
  const http = await publicHttp()
  const apps = (config.readState<any>().mastodon_apps ?? {}) as Record<string, { client_id: string; client_secret: string }>
  let app = apps[instance]
  if (!app) {
    const r = await registerApp(http)
    app = { client_id: r.client_id, client_secret: r.client_secret! }
    config.writeState({ mastodon_apps: { ...apps, [instance]: app } })
  }
  const url = http.url("oauth/authorize", { response_type: "code", client_id: app.client_id, redirect_uri: OOB, scope: SCOPES })
  note(`Opening the browser to authorise social-cli on ${instance}. Sign in, approve, then paste the code shown.\n${url}`)
  Bun.spawn(["open", url])
  const code = prompt("Authorization code:")?.trim()
  if (!code) throw new Error("no authorization code entered")
  const form: TokenRequest = { grant_type: "authorization_code", code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: OOB, scope: SCOPES }
  const t = await http.request<Token>({ method: "POST", path: "oauth/token", form })
  const where = await config.set("MASTODON_ACCESS_TOKEN", t.access_token)
  const me = await (await userHttp()).request<CredentialAccount>({ path: "api/v1/accounts/verify_credentials" })
  note(`Signed in as @${me.acct}@${instance}; token (scopes: ${t.scope}) stored in ${where === "keyring" ? "the OS keyring" : config.ENV_FILE}. Mastodon tokens do not expire.`)
}

// https://docs.joinmastodon.org/methods/media/#v2  200 = ready, 202 = still processing (poll GET /api/v1/media/:id until it is not 206).
async function uploadMedia(http: Http, file: string, description?: string): Promise<MediaAttachment> {
  const fd = new FormData()
  fd.append("file", new Blob([await Bun.file(file).arrayBuffer()]), file.split("/").pop()!)
  if (description) fd.append("description", description)
  let m = await http.request<MediaAttachment>({ method: "POST", path: "api/v2/media", body: fd })
  for (let i = 0; !m.url && !("dry_run" in m) && i < 30; i++) {
    await Bun.sleep(1000)
    m = await http.request<MediaAttachment>({ path: `api/v1/media/${m.id}` })
  }
  return m
}

const text = (html: string | null | undefined) => (html ?? "").replace(/<br\s*\/?>/g, " ").replace(/<\/p>\s*<p>/g, " ").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim()
const line = (s: Status) => `${s.id}  ${s.created_at.slice(0, 16)}  @${s.account.acct}  ${s.reblog ? "RT @" + s.reblog.account.acct + ": " + text(s.reblog.content) : text(s.content)}`.slice(0, 160)
const acct = (a: Account) => `@${a.acct} (${a.id})  ${a.display_name}  followers ${a.followers_count}  following ${a.following_count}  posts ${a.statuses_count}\n${a.url}\n${text(a.note)}`

export const mastodon: Platform = {
  name: "mastodon",
  summary: "Mastodon (any instance): post, reply, delete, upload media, home timeline, notifications, profiles",
  spec: { kind: "openapi", source: "https://raw.githubusercontent.com/abraham/mastodon-openapi/main/dist/schema.json" },
  credentials: { keys: KEYS, hint: HINT, docsUrl: "https://docs.joinmastodon.org/client/token/" },
  http: userHttp,
  auth: login,
  // https://docs.joinmastodon.org/methods/accounts/#verify_credentials
  async whoami() {
    const r = await (await userHttp()).request<CredentialAccount>({ path: "api/v1/accounts/verify_credentials" })
    return { id: r.id, acct: r.acct, instance: (await baseUrl()).replace(/^https?:\/\//, "") }
  },
  register(cmd: Command) {
    // https://docs.joinmastodon.org/methods/statuses/#create
    cmd.command("post <text>").description("publish a status").option("--reply-to <id>", "reply to a status id").option("--visibility <v>", "public | unlisted | private | direct").option("--cw <text>", "content warning (spoiler_text)").option("--media <files...>", "attach local files (uploaded via /api/v2/media first)").option("--json").option("--jq <e>")
      .action(async (status, o) => {
        const h = await userHttp()
        const body: Record<string, unknown> = { status }
        if (o.replyTo) body.in_reply_to_id = o.replyTo
        if (o.visibility) body.visibility = o.visibility
        if (o.cw) body.spoiler_text = o.cw
        if (o.media) { const ids: string[] = []; for (const f of o.media) { note(`uploading ${f}`); ids.push((await uploadMedia(h, f)).id) }; body.media_ids = ids }
        const r = await h.request<Status>({ method: "POST", path: "api/v1/statuses", body, headers: { "idempotency-key": crypto.randomUUID() } })
        await emit(r, o, (d) => d.dry_run ? "(dry run)" : d.url ?? d.uri)
      })
    // https://docs.joinmastodon.org/methods/statuses/#delete  (returns the deleted status with its source `text`)
    cmd.command("delete <id>").description("delete a status you posted").option("--json").option("--jq <e>").action(async (id, o) => {
      const h = await userHttp(); await emit(await h.request<Status & { text?: string }>({ method: "DELETE", path: `api/v1/statuses/${id}` }), o, (d) => d.dry_run ? "(dry run)" : `deleted ${d.id}: ${(d.text ?? text(d.content)).slice(0, 100)}`)
    })
    // https://docs.joinmastodon.org/methods/media/#v2
    cmd.command("upload <file>").description("upload an image/video for --media; prints the attachment id").option("--description <alt>", "alt text").option("--json").option("--jq <e>").action(async (file, o) => {
      const h = await userHttp(); await emit(await uploadMedia(h, file, o.description), o, (d) => d.dry_run ? "(dry run)" : `${d.id}  ${d.type}  ${d.url ?? "(processing)"}`)
    })
    // https://docs.joinmastodon.org/methods/timelines/#home
    cmd.command("timeline").description("your home timeline").option("-n, --max <n>", "count (max 40)", "20").option("--json").option("--jq <e>").action(async (o) => {
      const h = await userHttp(); await emit(await h.request<Status[]>({ path: "api/v1/timelines/home", query: { limit: Math.min(40, Number(o.max)) } }), o, (d) => d.map(line).join("\n") || "(empty)")
    })
    // https://docs.joinmastodon.org/methods/accounts/#lookup  (public; instance-local username or user@domain)
    cmd.command("profile <acct>").description("look up an account by username or user@domain (no token needed)").option("--json").option("--jq <e>").action(async (a, o) => {
      const h = (await config.get("MASTODON_ACCESS_TOKEN")) ? await userHttp() : await publicHttp()
      await emit(await h.request<Account>({ path: "api/v1/accounts/lookup", query: { acct: a.replace(/^@/, "") } }), o, acct)
    })
    // https://docs.joinmastodon.org/methods/accounts/#verify_credentials
    cmd.command("me").description("the authenticated account").option("--json").option("--jq <e>").action(async (o) => {
      const h = await userHttp(); await emit(await h.request<CredentialAccount>({ path: "api/v1/accounts/verify_credentials" }), o, acct)
    })
    // https://docs.joinmastodon.org/methods/notifications/#get
    cmd.command("notifications").description("recent mentions, follows, boosts, favourites").option("-n, --max <n>", "count (max 80)", "20").option("--types <t...>", "only these types (mention follow reblog favourite …)").option("--json").option("--jq <e>").action(async (o) => {
      const h = await userHttp()
      const r = await h.request<Notification[]>({ path: "api/v1/notifications", query: { limit: Math.min(80, Number(o.max)), "types[]": o.types } })
      await emit(r, o, (d) => d.map((n: Notification) => `${n.id}  ${n.created_at.slice(0, 16)}  ${n.type.padEnd(10)} @${n.account.acct}${n.status ? "  " + text(n.status.content).slice(0, 80) : ""}`).join("\n") || "(none)")
    })
  },
}
