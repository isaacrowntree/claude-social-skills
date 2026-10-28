/**
 * Etsy, generated from Etsy's own Open API v3 description
 * (https://www.etsy.com/openapi/generated/oas/3.0.0.json). Every operation is a
 * `social etsy call <id>` away (getMe, getListingsByShop, createDraftListing…).
 *
 * Auth: every request carries `x-api-key: <keystring>:<shared secret>` (the token endpoint
 * too; Etsy answers 403 without it). Operations that act for a seller also need an OAuth
 * token: authorization code with PKCE, the keystring as client_id and no client secret.
 * Etsy access tokens last an hour and refresh for 90 days.
 */
import type { Command } from "commander"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"
import { Generated, registerGenerated, type RestOp } from "../../core/openapi.ts"
import { browserConsent, pkce } from "../../core/oauth.ts"

const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token"
const DEFAULT_REDIRECT = "https://localhost:8086/callback"
const DEFAULT_SCOPES = "listings_r listings_w shops_r shops_w transactions_r profile_r email_r"
const isEtsyHost = (h: string) => h === "etsy.com" || h.endsWith(".etsy.com")

interface Tokens { access_token: string; refresh_token: string; expires_at: number; refresh_expires_at: number }

async function keys() {
  return config.require(["ETSY_KEYSTRING", "ETSY_SHARED_SECRET"], "Create an app at https://www.etsy.com/developers/your-apps; its keystring and shared secret are on that page.")
}
async function apiKey() { const k = await keys(); return `${k.ETSY_KEYSTRING}:${k.ETSY_SHARED_SECRET}` }

/** POST to the token endpoint; sent even under --dry-run (a faked reply would erase the stored token). */
async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const http = makeHttp({ baseUrl: TOKEN_URL, allowHost: isEtsyHost })
  const r = await http.request<any>({ method: "POST", path: TOKEN_URL, form, noDryRun: true, headers: { "x-api-key": await apiKey() } })
  if (!r?.access_token) throw new Error(`Etsy's token endpoint returned no access_token: ${JSON.stringify(r).slice(0, 300)}`)
  const prev = (config.readState<any>().etsy_tokens ?? {}) as Partial<Tokens>
  const now = Date.now()
  // Refresh tokens last 90 days and are reissued on each refresh.
  const t: Tokens = { access_token: r.access_token, refresh_token: r.refresh_token ?? prev.refresh_token!, expires_at: now + (r.expires_in ?? 3600) * 1000, refresh_expires_at: r.refresh_token ? now + 90 * 86400000 : prev.refresh_expires_at ?? 0 }
  config.writeState({ etsy_tokens: t })
  return t
}

async function accessToken(force = false): Promise<string> {
  let t = config.readState<any>().etsy_tokens as Tokens | undefined
  if (!t) throw new Error("This Etsy operation acts for a seller: run `social auth login etsy` first.")
  if (force || Date.now() > t.expires_at - 60_000) {
    if (Date.now() > t.refresh_expires_at) throw new Error("Etsy refresh token expired; run `social auth login etsy` again.")
    t = await tokenRequest({ grant_type: "refresh_token", client_id: (await keys()).ETSY_KEYSTRING, refresh_token: t.refresh_token })
  }
  return t.access_token
}

/** The key always; a seller token only for operations whose spec lists oauth2. */
async function client(op: RestOp | undefined, baseUrl: string): Promise<Http> {
  let force = false
  const needsUser = !!op?.schemes.includes("oauth2")
  return makeHttp({
    baseUrl, allowHost: isEtsyHost,
    headers: async () => ({ "x-api-key": await apiKey(), accept: "application/json", ...(needsUser ? { authorization: `Bearer ${await accessToken(force)}` } : {}) }),
    onUnauthorized: async () => (needsUser && !force ? (force = true) : false),
  })
}

async function login(): Promise<void> {
  const { ETSY_KEYSTRING } = await keys()
  const redirect = (await config.get("ETSY_REDIRECT_URI")) ?? DEFAULT_REDIRECT
  const scopes = (await config.get("ETSY_SCOPES")) ?? DEFAULT_SCOPES
  const { verifier, challenge } = pkce()
  const code = await browserConsent({
    listen: redirect, what: "Etsy",
    consentUrl: (state) => `https://www.etsy.com/oauth/connect?${new URLSearchParams({ response_type: "code", client_id: ETSY_KEYSTRING, redirect_uri: redirect, scope: scopes, state, code_challenge: challenge, code_challenge_method: "S256" })}`,
  })
  const t = await tokenRequest({ grant_type: "authorization_code", client_id: ETSY_KEYSTRING, redirect_uri: redirect, code, code_verifier: verifier })
  note(`Etsy OAuth stored. Access token good for ${Math.round((t.expires_at - Date.now()) / 60000)} min; refresh token 90 days.`)
}

export const generated = new Generated({ name: "etsy", indexFile: new URL("./ops.gen.json", import.meta.url).pathname, client: (op, base) => client(op, base) })

export const etsy: Platform = {
  name: "etsy",
  summary: "Etsy Open API v3: every operation (shop, listings, images, inventory, orders/receipts, shipping…), generated from Etsy's OpenAPI description",
  spec: { kind: "openapi", source: "www.etsy.com/openapi/generated/oas/3.0.0.json; pinned in spec-pins.json" },
  credentials: {
    keys: ["ETSY_KEYSTRING", "ETSY_SHARED_SECRET"], optionalKeys: ["ETSY_REDIRECT_URI", "ETSY_SCOPES"],
    hint: `Keystring and shared secret from https://www.etsy.com/developers/your-apps; public reads need only these. For seller operations register ${DEFAULT_REDIRECT} (or ETSY_REDIRECT_URI) as the app's callback URL and run \`social auth login etsy\`. ETSY_SCOPES overrides the default "${DEFAULT_SCOPES}".`,
    docsUrl: "https://developers.etsy.com/documentation/",
  },
  http: () => client(undefined, "https://openapi.etsy.com"),
  auth: login,
  async whoami() {
    // Signed in: the seller. Otherwise prove the key with Etsy's ping.
    if (config.readState<any>().etsy_tokens) { const r: any = await generated.call(await generated.find("getMe") as RestOp, { params: {} }); return { userId: r.user_id, shopId: r.shop_id } }
    const r: any = await generated.call(await generated.find("ping") as RestOp, { params: {} })
    return { appOnly: true, applicationId: r.application_id, note: "run `social auth login etsy` for seller operations" }
  },
  async skill() {
    return {
      body: `## Recipes

- Who am I (user and shop id): \`social etsy me\`
- Your listings: \`social etsy call getListingsByShop -p shop_id=<id> -p state=active --jq '.results[] | {listing_id, title, price: .price.amount}'\`
- Orders: \`social etsy call getShopReceipts -p shop_id=<id> -p was_shipped=false\`
- Change a listing (\`--dry-run\` first): \`social etsy call updateListing -p shop_id=<id> -p listing_id=<id> -f title='…'\`
- New listing: \`createDraftListing\` (describe it for the required fields), then \`uploadListingImage --file image=./photo.jpg\`, then activate with \`updateListing -f state=active\`.
- Search Etsy (key only, no sign-in): \`social etsy call findAllListingsActive -p keywords='leather boots' -p limit=5\`
`,
    }
  },
  register(cmd: Command) {
    registerGenerated(cmd, generated)
    cmd.command("me").description("the signed-in seller (getMe), or a key check (ping) when not signed in").option("--json").action(async (o) => {
      await emit(await etsy.whoami!(), o, (d) => d.appOnly ? `key ok, application ${d.applicationId} (not signed in): ${d.note}` : `user ${d.userId}  shop ${d.shopId}`)
    })
  },
}
