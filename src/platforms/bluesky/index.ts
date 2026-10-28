/**
 * Bluesky (AT Protocol). Spec: the app.bsky lexicons in the atproto repo
 * (https://github.com/bluesky-social/atproto/tree/main/lexicons/app/bsky, 165 JSON files);
 * `@atproto/api` is generated from them, so nothing is generated here. Bluesky also
 * publishes an OpenAPI rendering at https://endpoints.bsky.app/openapi.bluesky-app.json.
 *
 * Auth: an app password (https://bsky.app/settings/app-passwords) via
 * com.atproto.server.createSession. `@atproto/api`'s AtpAgent does login, resume
 * and refresh; the resulting session (accessJwt/refreshJwt/did/handle + the
 * account's PDS host from the DID document) is kept in state.json. Every request
 * then goes through makeHttp against `https://<pds>/xrpc` with the accessJwt as
 * bearer, so --dry-run, retries and ApiError apply. The PDS proxies app.bsky.*
 * reads to the AppView. Without a session, app.bsky.* GETs fall back to the
 * public AppView (https://public.api.bsky.app), which needs no token.
 *
 * Docs: https://bsky.network/docs/get-started (docs.bsky.app redirects here),
 * endpoint reference https://endpoints.bsky.app/, post shape
 * https://bsky.network/docs/about-bluesky-content/posts.
 */
import type { Command } from "commander"
import { AtpAgent, RichText, type AtpSessionData } from "@atproto/api"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, ApiError, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"
import { Generated, registerGenerated } from "../../core/openapi.ts"

const DEFAULT_SERVICE = "https://bsky.social"
const PUBLIC_APPVIEW = "https://public.api.bsky.app"
const KEYS = ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"]
const HINT = "Your handle (e.g. alice.bsky.social) and an app password from https://bsky.app/settings/app-passwords (never your main password). BLUESKY_SERVICE overrides the PDS for self-hosted accounts (default https://bsky.social)."
const POST = "app.bsky.feed.post"

/** What state.json keeps under `bluesky_session`: the SDK session plus where it was created and where the repo lives. */
interface Session extends AtpSessionData { service: string; pds: string }

async function service() { return ((await config.get("BLUESKY_SERVICE")) ?? DEFAULT_SERVICE).replace(/\/$/, "") }

function jwtExp(jwt: string): number {
  try { return Number(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).exp) * 1000 } catch { return 0 }
}

function agentFor(svc: string): AtpAgent {
  const agent: AtpAgent = new AtpAgent({
    service: svc,
    persistSession: (evt, s) => {
      // 'create'/'update' fire before the agent learns the PDS from the DID doc, so the pds is written by save() below.
      if (evt === "expired" || evt === "create-failed") config.writeState({ bluesky_session: undefined })
      else if (s) config.writeState({ bluesky_session: { ...(config.readState<any>().bluesky_session ?? {}), ...s, service: svc } })
    },
  })
  return agent
}

function save(agent: AtpAgent, svc: string): Session {
  const s: Session = { ...agent.session!, service: svc, pds: (agent.pdsUrl?.toString() ?? svc).replace(/\/$/, "") }
  config.writeState({ bluesky_session: s })
  return s
}

/** com.atproto.server.createSession with handle + app password (https://endpoints.bsky.app/#tag/com.atproto.server/POST/xrpc/com.atproto.server.createSession). */
async function login(): Promise<Session> {
  const c = await config.require(KEYS, HINT)
  const svc = await service()
  const agent = agentFor(svc)
  try { await agent.login({ identifier: c.BLUESKY_HANDLE, password: c.BLUESKY_APP_PASSWORD }) } catch (e: any) {
    // The PDS answers 401 {"error":"AuthenticationRequired","message":"Invalid identifier or password"} (verified live 2026-09-18).
    throw new Error(`Bluesky login failed for ${c.BLUESKY_HANDLE} at ${svc}: ${e?.error ?? ""} ${e?.message ?? e}`.trim() + "\nCheck BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password, not your account password).")
  }
  return save(agent, svc)
}

/** The stored session, resumed (com.atproto.server.getSession / refreshSession) when the access token is near expiry, or created from the credentials. */
async function session(force = false): Promise<Session> {
  const s = config.readState<any>().bluesky_session as Session | undefined
  if (!s) return login()
  if (!force && Date.now() < jwtExp(s.accessJwt) - 60_000) return s
  const agent = agentFor(s.service ?? DEFAULT_SERVICE)
  try { await agent.resumeSession(s) } catch (e: any) {
    if (["ExpiredToken", "InvalidToken"].includes(e?.error)) return login()
    throw e
  }
  return save(agent, s.service ?? DEFAULT_SERVICE)
}

/** Authenticated XRPC client against the account's PDS. A 400 ExpiredToken/InvalidToken (the PDS uses 400, not 401) resumes once and retries. */
async function userHttp(): Promise<Http> {
  let s = await session()
  const client = (sess: Session) => makeHttp({ baseUrl: `${sess.pds}/xrpc`, headers: () => ({ authorization: `Bearer ${sess.accessJwt}` }) })
  let base = client(s)
  return {
    url: (p, q) => base.url(p, q),
    async request(init) {
      try { return await base.request(init) } catch (e) {
        const err = e instanceof ApiError ? (e.json as any)?.error : undefined
        if (e instanceof ApiError && e.status === 400 && ["ExpiredToken", "InvalidToken"].includes(err)) { s = await session(true); base = client(s); return base.request(init) }
        throw e
      }
    },
  }
}

/** Public AppView for unauthenticated app.bsky.* reads. */
function publicHttp(): Http { return makeHttp({ baseUrl: `${PUBLIC_APPVIEW}/xrpc` }) }

async function haveCreds() { return !!config.readState<any>().bluesky_session || (await Promise.all(KEYS.map((k) => config.get(k)))).every(Boolean) }
async function anyHttp(): Promise<Http> { return (await haveCreds()) ? userHttp() : publicHttp() }

/** at://did/collection/rkey → parts; a bare rkey is taken as one of the caller's posts. */
function parseUri(uri: string, did: string) {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/)
  return m ? { repo: m[1]!, collection: m[2]!, rkey: m[3]! } : { repo: did, collection: POST, rkey: uri }
}
const postUrl = (handle: string, uri: string) => `https://bsky.app/profile/${handle}/post/${uri.split("/").pop()}`

/** Text → facets for links/mentions/tags (https://bsky.network/docs/about-bluesky-content/posts). Mentions resolve through com.atproto.identity.resolveHandle. */
async function facets(h: Http, text: string) {
  const rt = new RichText({ text })
  rt.detectFacetsWithoutResolution()
  const out = []
  for (const f of rt.facets ?? []) {
    let keep = true
    for (const feat of f.features) {
      if (feat.$type === "app.bsky.richtext.facet#mention") {
        try { (feat as any).did = (await h.request<any>({ path: "com.atproto.identity.resolveHandle", query: { handle: (feat as any).did } })).did } catch { keep = false }
      }
    }
    if (keep) out.push(f)
  }
  return out.length ? out : undefined
}

const feedLine = (i: any) => `${i.post.uri}  ${i.post.record?.createdAt?.slice(0, 16) ?? ""}  @${i.post.author.handle}${i.reason?.$type?.endsWith("#reasonRepost") ? " (repost)" : ""}: ${(i.post.record?.text ?? "").replace(/\n/g, " ").slice(0, 80)}`
const profileLine = (d: any) => `@${d.handle} (${d.did})  followers ${d.followersCount ?? 0}  following ${d.followsCount ?? 0}  posts ${d.postsCount ?? 0}\n${d.description ?? ""}`

/**
 * Every operation in Bluesky's OpenAPI rendering of the lexicons, generated: `social bluesky ops | describe | call` send them
 * through the same authenticated client as the commands below.
 */
export const generated = new Generated({
  name: "bluesky", indexFile: new URL("./ops.gen.json", import.meta.url).pathname,
  client: async () => anyHttp(),
  defaults: async () => { const origin = new URL((await anyHttp()).url("")).origin; return { server: () => origin } },
})

export const bluesky: Platform = {
  name: "bluesky",
  summary: "Bluesky (AT Protocol): post, reply, delete, timeline, profiles; any XRPC method via `social api bluesky`",
  spec: { kind: "lexicon", source: "https://github.com/bluesky-social/atproto/tree/main/lexicons/app/bsky (typed client: @atproto/api)" },
  credentials: { keys: KEYS, hint: HINT, docsUrl: "https://bsky.network/docs/get-started" },
  http: userHttp,
  async auth() {
    const s = await login()
    note(`Bluesky session stored for @${s.handle} (${s.did}) on ${s.pds}; access token good for ~${Math.round((jwtExp(s.accessJwt) - Date.now()) / 60000)} min, refreshed automatically.`)
  },
  async whoami() {
    // com.atproto.server.getSession: https://endpoints.bsky.app/#tag/com.atproto.server/GET/xrpc/com.atproto.server.getSession
    const r = await (await userHttp()).request<any>({ path: "com.atproto.server.getSession" })
    return { did: r.did, handle: r.handle, active: r.active }
  },
  register(cmd: Command) {
    registerGenerated(cmd, generated)
    // com.atproto.repo.createRecord: https://endpoints.bsky.app/#tag/com.atproto.repo/POST/xrpc/com.atproto.repo.createRecord
    // com.atproto.repo.uploadBlob (raw bytes, content-type = mime): https://endpoints.bsky.app/#tag/com.atproto.repo/POST/xrpc/com.atproto.repo.uploadBlob
    // app.bsky.feed.getPosts (reply root/parent lookup): https://endpoints.bsky.app/#tag/app.bsky.feed/GET/xrpc/app.bsky.feed.getPosts
    cmd.command("post <text>").description("post to Bluesky (links, @mentions and #tags become facets)").option("--reply-to <uri>", "reply to a post at:// uri").option("--image <files...>", "attach up to 4 images (≤1 MB each)").option("--alt <texts...>", "alt text per image, in order").option("--json").option("--jq <e>")
      .action(async (text, o) => {
        const h = await userHttp(); const s = await session()
        const record: any = { $type: POST, text, createdAt: new Date().toISOString(), facets: await facets(h, text) }
        if (o.replyTo) {
          const parent = (await h.request<any>({ path: "app.bsky.feed.getPosts", query: { uris: [o.replyTo] } })).posts?.[0]
          if (!parent) throw new Error(`post not found: ${o.replyTo}`)
          record.reply = { parent: { uri: parent.uri, cid: parent.cid }, root: parent.record?.reply?.root ?? { uri: parent.uri, cid: parent.cid } }
        }
        if (o.image?.length) {
          if (o.image.length > 4) throw new Error("Bluesky allows at most 4 images per post")
          const images = []
          for (const [i, file] of (o.image as string[]).entries()) {
            const f = Bun.file(file); if (!(await f.exists())) throw new Error(`image not found: ${file}`)
            const r = await h.request<any>({ method: "POST", path: "com.atproto.repo.uploadBlob", body: new Uint8Array(await f.arrayBuffer()), headers: { "content-type": f.type || "application/octet-stream" } })
            images.push({ alt: o.alt?.[i] ?? "", image: r.blob })
          }
          record.embed = { $type: "app.bsky.embed.images", images }
        }
        const r = await h.request<any>({ method: "POST", path: "com.atproto.repo.createRecord", body: { repo: s.did, collection: POST, record } })
        await emit(r, o, (d) => d.dry_run ? "(dry run)" : `${postUrl(s.handle, d.uri)}\n${d.uri}`)
      })

    // com.atproto.repo.deleteRecord: https://endpoints.bsky.app/#tag/com.atproto.repo/POST/xrpc/com.atproto.repo.deleteRecord
    cmd.command("delete <uri>").description("delete one of your posts by at:// uri (or rkey)").option("--json").action(async (uri, o) => {
      const h = await userHttp(); const s = await session()
      const { repo, collection, rkey } = parseUri(uri, s.did)
      await emit(await h.request({ method: "POST", path: "com.atproto.repo.deleteRecord", body: { repo, collection, rkey } }), o, (d) => d?.dry_run ? "(dry run)" : `deleted at://${repo}/${collection}/${rkey}`)
    })

    // app.bsky.feed.getTimeline (home, auth) / app.bsky.feed.getAuthorFeed (public): https://endpoints.bsky.app/#tag/app.bsky.feed
    cmd.command("timeline [handle]").description("your home timeline, or a given account's posts (no login needed for the latter)").option("-n, --max <n>", "count (1-100)", "20").option("--json").option("--jq <e>").action(async (handle, o) => {
      const limit = Math.min(100, Math.max(1, Number(o.max)))
      const r = handle
        ? await (await anyHttp()).request<any>({ path: "app.bsky.feed.getAuthorFeed", query: { actor: handle.replace(/^@/, ""), limit } })
        : await (await userHttp()).request<any>({ path: "app.bsky.feed.getTimeline", query: { limit } })
      await emit(r, o, (d) => (d.feed ?? []).map(feedLine).join("\n") || "(no posts)")
    })

    // app.bsky.actor.getProfile: https://endpoints.bsky.app/#tag/app.bsky.actor/GET/xrpc/app.bsky.actor.getProfile
    cmd.command("profile <handle>").description("look up an account by handle or did (no login needed)").option("--json").option("--jq <e>").action(async (handle, o) => {
      await emit(await (await anyHttp()).request({ path: "app.bsky.actor.getProfile", query: { actor: handle.replace(/^@/, "") } }), o, profileLine)
    })

    cmd.command("me").description("the authenticated account").option("--json").option("--jq <e>").action(async (o) => {
      const h = await userHttp(); const s = await session()
      await emit(await h.request({ path: "app.bsky.actor.getProfile", query: { actor: s.did } }), o, profileLine)
    })
  },
}
