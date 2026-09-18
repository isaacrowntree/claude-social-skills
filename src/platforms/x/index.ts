/**
 * X (Twitter) API v2. Spec: https://api.x.com/2/openapi.json (official OpenAPI 3).
 * Auth: OAuth 1.0a user context for anything that writes (tweets, likes, media),
 * app-only bearer for read-only endpoints when no user keys are present.
 */
import type { Command } from "commander"
import OAuth from "oauth-1.0a"
import { createHmac } from "node:crypto"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit } from "../../core/output.ts"

const BASE = "https://api.x.com/2"
const USER_KEYS = ["TWITTER_API_KEY", "TWITTER_API_SECRET", "TWITTER_ACCESS_TOKEN", "TWITTER_ACCESS_TOKEN_SECRET"]

/** App-only bearer: read-only endpoints (lookups, timelines by id, search). */
async function bearerHttp(): Promise<Http> {
  const { TWITTER_BEARER_TOKEN } = await config.require(["TWITTER_BEARER_TOKEN"], "The app's Bearer Token from the X developer portal (read-only access).")
  return makeHttp({ baseUrl: BASE, headers: () => ({ authorization: `Bearer ${TWITTER_BEARER_TOKEN}` }) })
}

/** User context when the four OAuth 1.0a keys exist, else app-only bearer for reads. */
async function anyHttp(): Promise<Http> {
  const have = (await Promise.all(USER_KEYS.map((k) => config.get(k)))).every(Boolean)
  return have ? userHttp() : bearerHttp()
}

async function userHttp(): Promise<Http> {
  const c = await config.require(USER_KEYS, "Create an app at https://developer.x.com/en/portal/dashboard with Read and Write permissions, then generate user access tokens.")
  const oauth = new OAuth({
    consumer: { key: c.TWITTER_API_KEY, secret: c.TWITTER_API_SECRET },
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) => createHmac("sha1", key).update(base).digest("base64"),
  })
  const token = { key: c.TWITTER_ACCESS_TOKEN, secret: c.TWITTER_ACCESS_TOKEN_SECRET }
  // OAuth 1.0a signs method+url(+form params). We sign per request via a header factory that needs the URL,
  // so wrap makeHttp with a request-scoped header.
  const base = makeHttp({ baseUrl: BASE })
  return {
    ...base,
    async request(init) {
      const method = (init.method ?? (init.body || init.form ? "POST" : "GET")).toUpperCase()
      const url = base.url(init.path, init.query)
      const data = init.form ?? undefined
      const auth = oauth.toHeader(oauth.authorize({ url, method, data: data as any }, token))
      return base.request({ ...init, headers: { ...auth, ...init.headers } })
    },
  }
}

export const x: Platform = {
  name: "x",
  summary: "X (Twitter) API v2: post, reply, delete, read your timeline, upload media",
  spec: { kind: "openapi", source: "https://api.x.com/2/openapi.json" },
  credentials: { keys: [...USER_KEYS, "TWITTER_BEARER_TOKEN"], hint: "OAuth 1.0a user-context keys from the X developer portal.", docsUrl: "https://docs.x.com/x-api" },
  http: anyHttp,
  async whoami() {
    const have = (await Promise.all(USER_KEYS.map((k) => config.get(k)))).every(Boolean)
    if (have) { const r = await (await userHttp()).request<any>({ path: "users/me" }); return { id: r.data.id, username: r.data.username, auth: "user" } }
    const r = await (await bearerHttp()).request<any>({ path: "users/by/username/x" })
    return { auth: "app-only bearer (read-only)", probe: r.data?.username }
  },
  register(cmd: Command) {
    cmd.command("post <text>").description("post a tweet").option("--reply-to <id>", "reply to a tweet id").option("--media <ids...>", "media ids from `x upload`").option("--json").option("--jq <e>")
      .action(async (text, o) => {
        const h = await userHttp()
        const body: any = { text }
        if (o.replyTo) body.reply = { in_reply_to_tweet_id: o.replyTo }
        if (o.media) body.media = { media_ids: o.media }
        const r = await h.request<any>({ method: "POST", path: "tweets", body })
        await emit(r, o, (d) => d.dry_run ? "(dry run)" : `https://x.com/i/status/${d.data.id}`)
      })
    cmd.command("delete <id>").description("delete a tweet you posted").option("--json").action(async (id, o) => {
      const h = await userHttp(); await emit(await h.request({ method: "DELETE", path: `tweets/${id}` }), o, (d) => JSON.stringify(d.data))
    })
    cmd.command("user <username>").description("look up a public account (bearer token is enough)").option("--json").option("--jq <e>").action(async (u, o) => {
      const h = await anyHttp(); await emit(await h.request({ path: `users/by/username/${u.replace(/^@/, "")}`, query: { "user.fields": "public_metrics,created_at,description" } }), o, (d) => `@${d.data.username} (${d.data.id})  followers ${d.data.public_metrics?.followers_count}  since ${d.data.created_at?.slice(0, 10)}\n${d.data.description ?? ""}`)
    })
    cmd.command("me").description("the authenticated user").option("--json").option("--jq <e>").action(async (o) => {
      const h = await userHttp(); await emit(await h.request({ path: "users/me", query: { "user.fields": "public_metrics,created_at" } }), o, (d) => `@${d.data.username} (${d.data.id}) followers ${d.data.public_metrics?.followers_count}`)
    })
    cmd.command("timeline [username]").description("recent tweets: yours, or a given @username (bearer token is enough)").option("-n, --max <n>", "count (5-100)", "10").option("--json").option("--jq <e>").action(async (username, o) => {
      const h = await anyHttp()
      const id = username ? (await h.request<any>({ path: `users/by/username/${username.replace(/^@/, "")}` })).data.id : (await h.request<any>({ path: "users/me" })).data.id
      const r = await h.request<any>({ path: `users/${id}/tweets`, query: { max_results: Math.max(5, Number(o.max)), "tweet.fields": "created_at,public_metrics" } })
      await emit(r, o, (d) => (d.data ?? []).map((t: any) => `${t.id}  ${t.created_at}  ${t.text.replace(/\n/g, " ").slice(0, 100)}`).join("\n") || "(no tweets)")
    })
    cmd.command("upload <file>").description("upload an image/video for --media (v2 media upload)").option("--json").action(async (file, o) => {
      const h = await userHttp()
      const bytes = await Bun.file(file).arrayBuffer()
      const fd = new FormData(); fd.append("media", new Blob([bytes]), file.split("/").pop()!); fd.append("media_category", "tweet_image")
      const r = await h.request<any>({ method: "POST", path: "media/upload", body: fd })
      await emit(r, o, (d) => d.data?.id ?? d.id ?? JSON.stringify(d))
    })
  },
}
