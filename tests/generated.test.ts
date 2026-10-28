import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Config is read lazily, but set it before any platform module loads.
const dir = mkdtempSync(join(tmpdir(), "social-generated-"))
process.env.SOCIAL_CONFIG_DIR = dir
process.env.DISCORD_BOT_TOKEN = "bot-tok"
process.env.ETSY_KEYSTRING = "ks"
process.env.ETSY_SHARED_SECRET = "sec"

const { Generated, discoveryOps, restOps, buildRest } = await import("../src/core/openapi.ts")
const { makeHttp } = await import("../src/core/http.ts")
const { browserConsent } = await import("../src/core/oauth.ts")

interface Seen { method: string; url: string; headers: Record<string, string>; body: string }
const seen: Seen[] = []
let reply: () => Response = () => Response.json({ ok: true })
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    seen.push({ method: req.method, url: req.url, headers, body: await req.text() })
    return reply()
  },
})
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`
beforeEach(() => { seen.length = 0; reply = () => Response.json({ ok: true }) })

describe("indexing", () => {
  test("single-spec platforms: ops grouped by tag (or first path segment), bare ids, humanised summaries when the spec has none", () => {
    const ops = restOps({
      servers: [{ url: "https://api.example.com/v5" }],
      paths: {
        "/pins": { post: { operationId: "pins/create", tags: ["pins"], summary: "Create Pin" } },
        "/channels/{channel_id}/messages": { post: { operationId: "create_message" } },
        "/v3/application/shops/{shop_id}": { get: { operationId: "getShop", tags: ["Shop Listing"], description: '<div><span class="wt-badge">General Release</span><a>Report bug</a></div><div><p>This endpoint is ready for production use.</p></div>\n\nRetrieves a shop by id.' } },
      },
    })
    expect(ops.map((o) => [o.id, o.api, o.summary])).toEqual([
      ["pins/create", "pins", "Create Pin"],
      ["create_message", "channels", "create message"],
      ["getShop", "shop_listing", "Retrieves a shop by id."],
    ])
  })

  test("Google Discovery methods become ops with their HTTP method, path and parameters", () => {
    const ops = discoveryOps({ rootUrl: "https://youtube.googleapis.com/", servicePath: "", resources: {
      videos: { methods: { list: { httpMethod: "GET", path: "youtube/v3/videos", description: "Retrieves a list of resources, possibly filtered.", scopes: ["https://www.googleapis.com/auth/youtube"],
        parameters: { part: { location: "query", required: true, type: "string", repeated: true }, id: { location: "query", type: "string" } } } } },
      liveChat: { resources: { messages: { methods: { insert: { httpMethod: "POST", path: "youtube/v3/liveChat/messages", request: { $ref: "LiveChatMessage" } } } } } },
    } })
    expect(ops[0]).toMatchObject({ id: "videos.list", api: "videos", method: "GET", server: "https://youtube.googleapis.com", path: "/youtube/v3/videos", summary: "Retrieves a list of resources, possibly filtered." })
    expect(ops[0].params).toEqual([{ name: "part", in: "query", required: true, type: "string[]", description: "" }, { name: "id", in: "query", required: false, type: "string", description: "" }])
    expect(ops[1]).toMatchObject({ id: "liveChat.messages.insert", api: "liveChat", body: { contentTypes: ["application/json"], required: true } })
  })
})

describe("Generated.call", () => {
  const op = (o: any) => ({ kind: "rest", id: "x", api: "a", operationId: "x", method: "GET", server: base, path: "/2/tweets/{id}", summary: "", params: [{ name: "id", in: "path", required: true, type: "string", description: "" }], scopes: [], schemes: [], auth: "user", scheme: "Bearer", keywords: "", ...o })

  test("goes through a platform's existing client as an absolute URL, so its own base path isn't doubled", async () => {
    // Like X's client: base already ends in /2, auth added per request.
    const g = new Generated({ name: "x", indexFile: "/nonexistent", client: async () => makeHttp({ baseUrl: `${base}/2`, headers: () => ({ authorization: "OAuth sig" }) }) })
    await g.call(op({}) as any, { params: { id: "42" } })
    expect(seen[0].url).toBe(`${base}/2/tweets/42`)
    expect(seen[0].headers.authorization).toBe("OAuth sig")
  })

  test("a platform's server default replaces the spec's placeholder host (Mastodon instance)", async () => {
    const g = new Generated({ name: "mastodon", indexFile: "/nonexistent", client: async () => makeHttp({ baseUrl: "https://ignored.example" }), defaults: async () => ({ server: () => base }) })
    await g.call(op({ server: "https://mastodon.example", path: "/api/v2/instance", params: [] }) as any, { params: {} })
    expect(seen[0].url).toBe(`${base}/api/v2/instance`)
  })

  test("defaults fill missing params and headers without overriding the caller's", () => {
    const r = buildRest(op({ params: [{ name: "id", in: "path", required: true, type: "string", description: "" }, { name: "X-Thing", in: "header", required: false, type: "string", description: "" }] }) as any,
      { params: { "x-thing": "mine" } }, { params: { id: "7", "X-Thing": "default" }, headers: () => ({ "x-thing": "nope", Extra: "1" }) })
    expect(r.path).toBe("/2/tweets/7")
    expect(r.headers).toEqual({ "X-Thing": "mine", Extra: "1" })
  })
})

describe("new platforms' auth", () => {
  test("Discord sends Bot <token> with Discord's user agent, and only to Discord", async () => {
    const { generated } = await import("../src/platforms/discord/index.ts")
    const http = await generated.cfg.client({} as any, "https://discord.com/api/v10")
    await expect(http.request({ path: `${base}/users/@me` })).rejects.toThrow(/refusing to send credentials to 127.0.0.1/)
    const real = globalThis.fetch
    globalThis.fetch = ((url: any, init: any) => real(String(url).replace(/^https:\/\/discord\.com/, base), init)) as typeof fetch
    try { await http.request({ path: "https://discord.com/api/v10/users/@me" }) } finally { globalThis.fetch = real }
    expect(seen[0].headers.authorization).toBe("Bot bot-tok")
    expect(seen[0].headers["user-agent"]).toMatch(/^DiscordBot \(/)
  })

  test("Etsy sends the keystring:secret key always, and a Bearer only for operations whose spec lists oauth2", async () => {
    const { generated } = await import("../src/platforms/etsy/index.ts")
    const config = await import("../src/core/config.ts")
    config.writeState({ etsy_tokens: { access_token: "1.etsy", refresh_token: "r", expires_at: Date.now() + 3600_000, refresh_expires_at: Date.now() + 86400_000 } })
    const g = new Generated({ name: "etsy", indexFile: "/nonexistent", client: async (o: any, b: string) => generated.cfg.client(o, b) })
    // The Etsy client only talks to *.etsy.com; route its requests to the fake by patching fetch for this test.
    const real = globalThis.fetch
    globalThis.fetch = ((url: any, init: any) => real(String(url).replace(/^https:\/\/openapi\.etsy\.com/, base), init)) as typeof fetch
    try {
      const pub = { kind: "rest", id: "ping", api: "a", operationId: "ping", method: "GET", server: "https://openapi.etsy.com", path: "/v3/application/openapi-ping", summary: "", params: [], scopes: [], schemes: ["api_key"], auth: "user", scheme: "Bearer", keywords: "" }
      await g.call(pub as any, { params: {} })
      await g.call({ ...pub, id: "getMe", schemes: ["api_key", "oauth2"] } as any, { params: {} })
    } finally { globalThis.fetch = real }
    expect(seen.map((s): (string | undefined)[] => [s.headers["x-api-key"], s.headers.authorization])).toEqual([["ks:sec", undefined], ["ks:sec", "Bearer 1.etsy"]])
  })
})

test("the consent server answers only a callback carrying its own state", async () => {
  let state = ""
  const listen = `http://localhost:${18000 + Math.floor(Math.random() * 1000)}/callback`
  const realSpawn = Bun.spawn
  ;(Bun as any).spawn = () => ({})
  try {
    const code = browserConsent({ listen, what: "Test", consentUrl: (s) => { state = s; return "https://example.invalid/consent" } })
    await Bun.sleep(50)
    const bad = await fetch(`${listen}?code=evil&state=wrong`)
    expect([bad.status, await bad.text()]).toEqual([400, "<h1>Authorisation failed: state mismatch</h1>"])
    const ok = await fetch(`${listen}?code=good&state=${state}`)
    expect(ok.status).toBe(200)
    expect(await code).toBe("good")
  } finally { (Bun as any).spawn = realSpawn }
})
