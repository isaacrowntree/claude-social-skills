/**
 * Facebook Pages, Instagram and Threads: three platforms, one Graph client (graph.ts).
 * No `auth()`: Meta's OAuth needs an app in review for anything beyond its own testers, so
 * each platform takes a long-lived token pasted once. How to mint one is in each `hint`.
 * Spec: none. Meta publishes no OpenAPI/discovery document for the Graph API.
 */
import type { Command } from "commander"
import type { Platform } from "../../core/platform.ts"
import type { Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"
import { GRAPH, graphHttp, waitForContainer } from "./graph.ts"

// ---------- Facebook Page ----------

const FB_KEYS = ["FB_PAGE_ID", "FB_PAGE_ACCESS_TOKEN"]
const FB_HINT = "Page token: in the Graph API Explorer (https://developers.facebook.com/tools/explorer) pick your app, add pages_manage_posts + pages_read_engagement + pages_show_list, generate a User token, exchange it for a long-lived one (GET /oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token), then GET /me/accounts with it: each page's access_token there is long-lived and does not expire. https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived"

async function fbHttp(): Promise<{ http: Http; page: string }> {
  const c = await config.require(FB_KEYS, FB_HINT)
  return { http: graphHttp(GRAPH.facebook, c.FB_PAGE_ACCESS_TOKEN), page: c.FB_PAGE_ID }
}

export const facebook: Platform = {
  name: "facebook",
  summary: "Facebook Page via the Graph API: post text, links and photos, read and delete your Page's posts",
  spec: { kind: "none", source: "none" },
  credentials: { keys: FB_KEYS, hint: FB_HINT, docsUrl: "https://developers.facebook.com/docs/graph-api/reference/page/feed/" },
  http: async () => (await fbHttp()).http,
  async whoami() {
    // https://developers.facebook.com/docs/graph-api/reference/page/
    const { http, page } = await fbHttp()
    const r = await http.request<any>({ path: page, query: { fields: "id,name" } })
    return { id: r.id, name: r.name }
  },
  register(cmd: Command) {
    // https://developers.facebook.com/docs/graph-api/reference/page/feed/  (message/link)
    // https://developers.facebook.com/docs/graph-api/reference/page/photos/ (url + caption; `link` is not accepted there)
    cmd.command("post <message>").description("post to the Page: text, optionally with a link or a hosted photo").option("--link <url>", "attach a link").option("--photo <url>", "attach a photo by public URL (posts via /photos)").option("--json").option("--jq <e>")
      .action(async (message, o) => {
        if (o.link && o.photo) throw new Error("--link and --photo cannot be combined; a photo post carries no link attachment")
        const { http, page } = await fbHttp()
        const r = o.photo
          ? await http.request<any>({ method: "POST", path: `${page}/photos`, form: { url: o.photo, caption: message } })
          : await http.request<any>({ method: "POST", path: `${page}/feed`, form: { message, link: o.link } })
        await emit(r, o, (d) => d.dry_run ? "(dry run)" : `https://facebook.com/${d.post_id ?? d.id}`)
      })
    cmd.command("posts").description("recent posts on the Page").option("-n, --max <n>", "count (1-100)", "10").option("--json").option("--jq <e>").action(async (o) => {
      const { http, page } = await fbHttp()
      const r = await http.request<any>({ path: `${page}/posts`, query: { fields: "id,message,created_time,permalink_url", limit: Math.min(100, Math.max(1, Number(o.max))) } })
      await emit(r, o, (d) => (d.data ?? []).map((p: any) => `${p.id}  ${p.created_time}  ${(p.message ?? "").replace(/\n/g, " ").slice(0, 100)}`).join("\n") || "(no posts)")
    })
    // https://developers.facebook.com/docs/graph-api/reference/page-post/#deleting
    cmd.command("delete <id>").description("delete a Page post").option("--json").action(async (id, o) => {
      const { http } = await fbHttp(); await emit(await http.request({ method: "DELETE", path: id }), o, (d) => d.dry_run ? "(dry run)" : d.success ? "deleted" : JSON.stringify(d))
    })
    cmd.command("me").description("the Page this token belongs to").option("--json").option("--jq <e>").action(async (o) => {
      const { http, page } = await fbHttp()
      await emit(await http.request<any>({ path: page, query: { fields: "id,name,link,fan_count,category" } }), o, (d) => `${d.name} (${d.id})  ${d.category ?? ""}  likes ${d.fan_count ?? "?"}  ${d.link ?? ""}`)
    })
  },
}

// ---------- Instagram (Business/Creator, Facebook Login flavour on graph.facebook.com) ----------

const IG_KEYS = ["IG_USER_ID", "IG_ACCESS_TOKEN"]
const IG_HINT = "Needs an Instagram Business/Creator account linked to a Facebook Page. Use the same long-lived Page token as Facebook (with instagram_basic + instagram_content_publish added in the Graph API Explorer); IG_USER_ID is GET /{page-id}?fields=instagram_business_account. https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing"

async function igHttp(): Promise<{ http: Http; user: string }> {
  const c = await config.require(IG_KEYS, IG_HINT)
  return { http: graphHttp(GRAPH.facebook, c.IG_ACCESS_TOKEN), user: c.IG_USER_ID }
}

/**
 * Content publishing is container → (poll status_code) → publish.
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
 */
async function igPublish(form: Record<string, string | undefined>, o: any, maxMs: number) {
  const { http, user } = await igHttp()
  const c = await http.request<any>({ method: "POST", path: `${user}/media`, form })
  if (!c.dry_run) note(`container ${c.id}`)
  await waitForContainer(http, c.id ?? "dry-run", "status_code", { intervalMs: 3000, maxMs })
  const r = await http.request<any>({ method: "POST", path: `${user}/media_publish`, form: { creation_id: c.id ?? "dry-run" } })
  await emit(r, o, (d) => d.dry_run ? "(dry run)" : `published media ${d.id}`)
}

export const instagram: Platform = {
  name: "instagram",
  summary: "Instagram Business/Creator via the Graph API: publish images and reels from public URLs, list your media",
  spec: { kind: "none", source: "none" },
  credentials: { keys: IG_KEYS, hint: IG_HINT, docsUrl: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api" },
  http: async () => (await igHttp()).http,
  async whoami() {
    // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user
    const { http, user } = await igHttp()
    const r = await http.request<any>({ path: user, query: { fields: "id,username" } })
    return { id: r.id, username: r.username }
  },
  register(cmd: Command) {
    cmd.command("post <image-url>").description("publish an image (public JPEG URL) as a feed post").option("--caption <text>", "caption, hashtags and @mentions allowed").option("--json").option("--jq <e>")
      .action((url, o) => igPublish({ image_url: url, caption: o.caption }, o, 2 * 60_000))
    cmd.command("reel <video-url>").description("publish a reel from a public video URL (waits for processing)").option("--caption <text>").option("--json").option("--jq <e>")
      .action((url, o) => igPublish({ video_url: url, media_type: "REELS", caption: o.caption }, o, 5 * 60_000))
    cmd.command("media").description("your recent media").option("-n, --max <n>", "count", "10").option("--json").option("--jq <e>").action(async (o) => {
      const { http, user } = await igHttp()
      const r = await http.request<any>({ path: `${user}/media`, query: { fields: "id,caption,media_type,permalink,timestamp", limit: Number(o.max) } })
      await emit(r, o, (d) => (d.data ?? []).map((m: any) => `${m.id}  ${m.timestamp}  ${m.media_type.padEnd(8)}  ${(m.caption ?? "").replace(/\n/g, " ").slice(0, 80)}`).join("\n") || "(no media)")
    })
    cmd.command("me").description("the Instagram account this token belongs to").option("--json").option("--jq <e>").action(async (o) => {
      const { http, user } = await igHttp()
      await emit(await http.request<any>({ path: user, query: { fields: "id,username,name,followers_count,media_count" } }), o, (d) => `@${d.username} (${d.id})  followers ${d.followers_count}  media ${d.media_count}`)
    })
  },
}

// ---------- Threads ----------

const THREADS_KEYS = ["THREADS_USER_ID", "THREADS_ACCESS_TOKEN"]
const THREADS_HINT = "Create an app with the Threads API use case, add yourself as a Threads Tester (accept in Threads > Settings > Account > Website permissions), authorise at https://threads.net/oauth/authorize?client_id=…&redirect_uri=…&scope=threads_basic,threads_content_publish&response_type=code, exchange the code (POST graph.threads.net/oauth/access_token; the reply carries user_id), then make it long-lived: GET graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=…&access_token=… (60 days; refresh with /refresh_access_token?grant_type=th_refresh_token). https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions"

async function threadsHttp(): Promise<{ http: Http; user: string }> {
  const c = await config.require(THREADS_KEYS, THREADS_HINT)
  return { http: graphHttp(GRAPH.threads, c.THREADS_ACCESS_TOKEN), user: c.THREADS_USER_ID }
}

export const threads: Platform = {
  name: "threads",
  summary: "Threads API: post text or an image, read your posts and profile",
  spec: { kind: "none", source: "none" },
  credentials: { keys: THREADS_KEYS, hint: THREADS_HINT, docsUrl: "https://developers.facebook.com/docs/threads" },
  http: async () => (await threadsHttp()).http,
  async whoami() {
    // https://developers.facebook.com/docs/threads/threads-profiles
    const { http } = await threadsHttp()
    const r = await http.request<any>({ path: "me", query: { fields: "id,username" } })
    return { id: r.id, username: r.username }
  },
  register(cmd: Command) {
    // https://developers.facebook.com/docs/threads/posts  (container → threads_publish; ~30s for media)
    cmd.command("post <text>").description("post to Threads (500 chars), optionally with a public image URL").option("--image <url>", "attach an image (JPEG/PNG, 8 MB max)").option("--json").option("--jq <e>")
      .action(async (text, o) => {
        const { http, user } = await threadsHttp()
        const form = o.image ? { media_type: "IMAGE", image_url: o.image, text } : { media_type: "TEXT", text }
        const c = await http.request<any>({ method: "POST", path: `${user}/threads`, form })
        if (!c.dry_run) note(`container ${c.id}`)
        await waitForContainer(http, c.id ?? "dry-run", "status", { intervalMs: o.image ? 15_000 : 3000, maxMs: 5 * 60_000 })
        const r = await http.request<any>({ method: "POST", path: `${user}/threads_publish`, form: { creation_id: c.id ?? "dry-run" } })
        await emit(r, o, (d) => d.dry_run ? "(dry run)" : `published thread ${d.id}`)
      })
    // https://developers.facebook.com/docs/threads/retrieve-and-discover-posts/retrieve-posts
    cmd.command("posts").description("your recent threads").option("-n, --max <n>", "count", "10").option("--json").option("--jq <e>").action(async (o) => {
      const { http, user } = await threadsHttp()
      const r = await http.request<any>({ path: `${user}/threads`, query: { fields: "id,text,media_type,permalink,timestamp", limit: Number(o.max) } })
      await emit(r, o, (d) => (d.data ?? []).map((t: any) => `${t.id}  ${t.timestamp}  ${(t.text ?? `[${t.media_type}]`).replace(/\n/g, " ").slice(0, 100)}`).join("\n") || "(no threads)")
    })
    cmd.command("me").description("the Threads profile this token belongs to").option("--json").option("--jq <e>").action(async (o) => {
      const { http } = await threadsHttp()
      await emit(await http.request<any>({ path: "me", query: { fields: "id,username,name,threads_biography" } }), o, (d) => `@${d.username} (${d.id})  ${d.name ?? ""}\n${d.threads_biography ?? ""}`.trim())
    })
  },
}
