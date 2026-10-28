/**
 * Pinterest, generated from Pinterest's own OpenAPI description of API v5
 * (github.com/pinterest/api-description). Every operation is a `social pinterest call <id>`
 * away (`pins/create`, `boards/list`, `user_account/get`…); this file only holds auth.
 *
 * Auth: OAuth 2.0 authorization code. Create an app at developers.pinterest.com (needs a
 * business account), add the redirect URI below to it, then `social auth login pinterest`.
 * Trial-access apps may only write to the sandbox: set PINTEREST_SANDBOX=1 until the app
 * has standard access.
 */
import type { Command } from "commander"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"
import { Generated, registerGenerated } from "../../core/openapi.ts"
import { browserConsent } from "../../core/oauth.ts"

const TOKEN_URL = "https://api.pinterest.com/v5/oauth/token"
const DEFAULT_REDIRECT = "https://localhost:8085/callback"
const DEFAULT_SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read"
const isPinterestHost = (h: string) => h === "pinterest.com" || h.endsWith(".pinterest.com")

interface Tokens { access_token: string; refresh_token: string; expires_at: number; refresh_expires_at: number }

async function appEnv() {
  return config.require(["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"], `Create an app at https://developers.pinterest.com/apps/, add ${DEFAULT_REDIRECT} as a redirect URI, then \`social auth login pinterest\`.`)
}
async function sandbox() { return ["1", "true", "yes"].includes((await config.get("PINTEREST_SANDBOX") ?? "").toLowerCase()) }

/** POST to the token endpoint; sent even under --dry-run (a faked reply would erase the stored token). */
async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const e = await appEnv()
  const http = makeHttp({ baseUrl: TOKEN_URL, allowHost: isPinterestHost })
  const r = await http.request<any>({ method: "POST", path: TOKEN_URL, form, noDryRun: true, headers: { authorization: "Basic " + Buffer.from(`${e.PINTEREST_CLIENT_ID}:${e.PINTEREST_CLIENT_SECRET}`).toString("base64") } })
  if (!r?.access_token) throw new Error(`Pinterest's token endpoint returned no access_token: ${JSON.stringify(r).slice(0, 300)}`)
  const prev = (config.readState<any>().pinterest_tokens ?? {}) as Partial<Tokens>
  const now = Date.now()
  const t: Tokens = {
    access_token: r.access_token, refresh_token: r.refresh_token ?? prev.refresh_token!,
    expires_at: now + (r.expires_in ?? 2592000) * 1000,
    refresh_expires_at: r.refresh_token_expires_in ? now + r.refresh_token_expires_in * 1000 : prev.refresh_expires_at ?? 0,
  }
  config.writeState({ pinterest_tokens: t })
  return t
}

async function accessToken(force = false): Promise<string> {
  let t = config.readState<any>().pinterest_tokens as Tokens | undefined
  if (!t) throw new Error("No Pinterest sign-in stored. Run `social auth login pinterest` (needs PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET).")
  if (force || Date.now() > t.expires_at - 60_000) {
    if (Date.now() > t.refresh_expires_at) throw new Error("Pinterest refresh token expired; run `social auth login pinterest` again.")
    t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, continuous_refresh: "true" })
  }
  return t.access_token
}

async function client(baseUrl: string): Promise<Http> {
  let force = false
  const base = (await sandbox()) ? baseUrl.replace("://api.pinterest.com", "://api-sandbox.pinterest.com") : baseUrl
  return makeHttp({
    baseUrl: base, allowHost: isPinterestHost,
    headers: async () => ({ authorization: `Bearer ${await accessToken(force)}`, accept: "application/json" }),
    onUnauthorized: async () => (!force ? (force = true) : false),
  })
}

async function login(): Promise<void> {
  const e = await appEnv()
  const redirect = (await config.get("PINTEREST_REDIRECT_URI")) ?? DEFAULT_REDIRECT
  const scopes = (await config.get("PINTEREST_SCOPES")) ?? DEFAULT_SCOPES
  const code = await browserConsent({
    listen: redirect, what: "Pinterest",
    consentUrl: (state) => `https://www.pinterest.com/oauth/?${new URLSearchParams({ client_id: e.PINTEREST_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: scopes, state })}`,
  })
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect, continuous_refresh: "true" })
  note(`Pinterest OAuth stored. Access token good for ~${Math.round((t.expires_at - Date.now()) / 86400000)} days; refreshed automatically.`)
}

export const generated = new Generated({
  name: "pinterest", indexFile: new URL("./ops.gen.json", import.meta.url).pathname,
  client: async (_op, base) => client(base),
  // Sandbox swaps the host in client(); describe shows the production server.
  defaults: async () => ({}),
})

export const pinterest: Platform = {
  name: "pinterest",
  summary: "Pinterest API v5: every operation (pins, boards, sections, media, analytics, ads…), generated from Pinterest's OpenAPI description",
  spec: { kind: "openapi", source: "github.com/pinterest/api-description v5/openapi.json; pinned in spec-pins.json" },
  credentials: {
    keys: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"], optionalKeys: ["PINTEREST_REDIRECT_URI", "PINTEREST_SCOPES", "PINTEREST_SANDBOX"],
    hint: `App id and secret from https://developers.pinterest.com/apps/ (a business account is needed). Register ${DEFAULT_REDIRECT} (or PINTEREST_REDIRECT_URI) as a redirect URI, then \`social auth login pinterest\`. PINTEREST_SCOPES overrides the default ${DEFAULT_SCOPES}. PINTEREST_SANDBOX=1 sends calls to api-sandbox.pinterest.com, which trial-access apps need for writes.`,
    docsUrl: "https://developers.pinterest.com/docs/api/v5/",
  },
  http: () => client("https://api.pinterest.com/v5"),
  auth: login,
  async whoami() {
    const r: any = await generated.call(await generated.find("user_account/get") as any, { params: {} })
    return { username: r.username, accountType: r.account_type }
  },
  async skill() {
    return {
      body: `## Recipes

- Who am I: \`social pinterest me\`
- Boards: \`social pinterest call boards/list --jq '.items[] | {id, name}'\`
- Create a pin from an image URL (\`--dry-run\` first):
  \`\`\`bash
  social pinterest call pins/create --input pin.json
  # pin.json: {"board_id": "<id>", "title": "…", "description": "…", "link": "https://…",
  #            "media_source": {"source_type": "image_url", "url": "https://…/photo.jpg"}}
  \`\`\`
- Your pins: \`social pinterest call pins/list --jq '.items[] | {id, title, link}'\`
- Video pins: register the upload with \`media/create\`, upload to the URL it returns, then create the pin with \`source_type: video_id\`.
`,
    }
  },
  register(cmd: Command) {
    registerGenerated(cmd, generated)
    cmd.command("me").description("the signed-in account (user_account/get)").option("--json").action(async (o) => { await emit(await pinterest.whoami!(), o, (d) => `${d.username}  ${d.accountType}`) })
  },
}
