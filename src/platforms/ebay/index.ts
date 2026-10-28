/**
 * eBay, generated. Every operation comes from eBay's own published descriptions,
 * pulled by `social specs pull ebay` (never committed):
 *
 *   REST     one OpenAPI 3 document per API (Inventory, Fulfillment, Account, Finances,
 *            Media, Message, Post-Order, Taxonomy, Marketing…), developer.ebay.com/develop/api/spec/<api>.json
 *   GraphQL  one schema for the modernized APIs (Listing, offers, orders, returns,
 *            inquiries…), served at https://graphqlapi.ebay.com/graphql
 *
 * build-index.ts indexes them; ops.ts calls them. This file only holds auth and the
 * command surface: `ops` / `describe` to discover, `call` / `gql` to run.
 *
 * Auth: OAuth user token (`social auth login ebay`, a RuName whose accept URL is
 * https://localhost:8888/callback) for seller operations; an app token (client
 * credentials, no sign-in) for the operations whose spec allows only that. The legacy
 * Trading API (Auth'n'Auth token) stays reachable as `social ebay trading <Call>`.
 */
import type { Command } from "commander"
import { readFileSync } from "node:fs"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, ApiError, type Http } from "../../core/http.ts"
import { browserConsent } from "../../core/oauth.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"
import { coerce, kv, io } from "../../commands/api.ts"
import { Generated, registerGenerated } from "../../core/openapi.ts"
import { INDEX_FILE } from "./build-index.ts"
import * as ops from "./ops.ts"

const CONTENT_LANGUAGE: Record<string, string> = { EBAY_US: "en-US", EBAY_GB: "en-GB", EBAY_AU: "en-AU", EBAY_DE: "de-DE", EBAY_CA: "en-CA" }
const API_SCOPE = "https://api.ebay.com/oauth/api_scope"
const S = (s: string) => `${API_SCOPE}/${s}`
// The Authorization Code scopes granted to this app (developer.ebay.com/my/keys → OAuth Scopes),
// read and write both, since GraphQL fields check either. Asking for one not granted fails the
// whole sign-in with invalid_scope (sell.negotiation is the known absentee). Refresh keeps
// whatever the sign-in got, so changing this list only takes effect at the next `auth login`.
const OAUTH_SCOPES = [
  API_SCOPE,
  ...["sell.marketing", "sell.marketing.readonly", "sell.inventory", "sell.inventory.readonly", "sell.account", "sell.account.readonly",
    "sell.fulfillment", "sell.fulfillment.readonly", "sell.analytics.readonly", "sell.finances", "sell.payment.dispute",
    "commerce.identity.readonly", "sell.reputation", "sell.reputation.readonly", "commerce.notification.subscription",
    "commerce.notification.subscription.readonly", "sell.stores", "sell.stores.readonly", "commerce.vero", "sell.inventory.mapping",
    "commerce.message", "commerce.feedback", "commerce.shipping", "sell.listing", "sell.listing.read", "sell.cancellation.read",
    "sell.cancellation", "sell.return.read", "sell.return", "sell.inquiry", "sell.inquiry.read", "commerce.post_order.document",
    "sell.offer", "commerce.catalog.readonly", "commerce.usernote", "sell.auction", "sell.auction.read", "sell.commitment",
    "sell.commitment.read", "sell.offer.read", "sell.order", "sell.order.read", "sell.purchase.quote", "sell.purchase.quote.read",
    "sell.refund.read", "sell.resolution.read", "sell.return.preference"].map(S),
  "https://api.ebay.com/oauth/scope/sell.edelivery",
]
// What sign-ins before 2026-10-28 asked for; tokens stored then don't record their scopes.
const FIRST_SCOPES = [API_SCOPE, ...["sell.inventory", "sell.marketing", "sell.account", "sell.fulfillment", "sell.analytics.readonly", "sell.finances", "sell.listing", "sell.offer", "sell.order", "sell.return", "sell.cancellation", "sell.inquiry", "sell.reputation", "commerce.identity.readonly", "commerce.message", "commerce.feedback"].map(S)]

async function sandbox() { return ["1", "true", "yes"].includes((await config.get("EBAY_SANDBOX") ?? "").toLowerCase()) }
async function apiBase() { return (await sandbox()) ? "https://api.sandbox.ebay.com" : "https://api.ebay.com" }
async function authBase() { return (await sandbox()) ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com" }
async function marketplace() { return (await config.get("EBAY_MARKETPLACE")) ?? "EBAY_AU" }

// ---------- Trading (Auth'n'Auth, legacy) ----------

const TRADING_VERSION = "1349"
const SITE_IDS: Record<string, string> = { EBAY_US: "0", EBAY_GB: "3", EBAY_AU: "15", EBAY_DE: "77", EBAY_CA: "2" }
const xml = {
  esc: (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  // Tags may carry attributes (<CurrentPrice currencyID="AUD">599.0</CurrentPrice>), so match `<Tag` + optional attrs.
  get: (text: string, tag: string) => text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? "",
  all: (text: string, tag: string) => [...text.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]),
}

export async function trading(callName: string, body: string, opts: { site?: string } = {}): Promise<string> {
  const { EBAY_AUTH_TOKEN } = await config.require(["EBAY_AUTH_TOKEN"], "Get a User Token (Auth'n'Auth) at https://developer.ebay.com/my/auth?env=production&index=0&auth_type=auth. Only the legacy Trading API needs it.")
  const site = opts.site ?? SITE_IDS[await marketplace()] ?? "0"
  const http = makeHttp({ baseUrl: (await apiBase()) + "/ws", allowHost: ops.isEbayHost })
  const req = `<?xml version="1.0" encoding="utf-8"?>\n<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xml.esc(EBAY_AUTH_TOKEN)}</eBayAuthToken></RequesterCredentials>${body}</${callName}Request>`
  const text = await http.request<string>({
    method: "POST", path: "api.dll", raw: true, body: req,
    headers: { "content-type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_VERSION, "X-EBAY-API-CALL-NAME": callName, "X-EBAY-API-SITEID": site },
  })
  if (xml.get(text, "Ack") === "Failure") {
    const errs = xml.all(text, "Errors").map((e) => `${xml.get(e, "ErrorCode")}: ${xml.get(e, "LongMessage") || xml.get(e, "ShortMessage")}`)
    throw new ApiError(200, `Trading ${callName} failed:\n${errs.join("\n")}`, "api.dll", "POST")
  }
  return text
}

// ---------- OAuth ----------

interface StoredTokens { access_token: string; refresh_token: string; expires_at: number; refresh_expires_at: number; scopes?: string[] }

async function oauthEnv() {
  return config.require(["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"], "Create an app at https://developer.ebay.com/my/keys, add a RuName whose accept URL is https://localhost:8888/callback, then `social auth login ebay`.")
}
function basic(id: string, secret: string) { return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") }

/** POST to the token endpoint. Sent even under --dry-run: it changes nothing remote, and a faked reply would erase the stored token. */
async function tokenEndpoint(form: Record<string, string>): Promise<any> {
  const e = await config.require(["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"], "eBay operations need your app's client id and secret from https://developer.ebay.com/my/keys.")
  const http = makeHttp({ baseUrl: await apiBase(), allowHost: ops.isEbayHost })
  const r = await http.request<any>({ method: "POST", path: "identity/v1/oauth2/token", form, headers: { authorization: basic(e.EBAY_CLIENT_ID, e.EBAY_CLIENT_SECRET) }, noDryRun: true })
  if (!r?.access_token) throw new Error(`eBay's token endpoint returned no access_token: ${JSON.stringify(r).slice(0, 300)}`)
  return r
}

async function userTokenRequest(form: Record<string, string>, scopes?: string[]): Promise<StoredTokens> {
  const r = await tokenEndpoint(form)
  const now = Date.now()
  const prev = (config.readState<any>().ebay_tokens ?? {}) as Partial<StoredTokens>
  const t: StoredTokens = {
    access_token: r.access_token,
    refresh_token: r.refresh_token ?? prev.refresh_token!,
    expires_at: now + (r.expires_in ?? 7200) * 1000,
    refresh_expires_at: r.refresh_token_expires_in ? now + r.refresh_token_expires_in * 1000 : prev.refresh_expires_at ?? 0,
    scopes: scopes ?? prev.scopes,
  }
  config.writeState({ ebay_tokens: t })
  return t
}

async function userToken(force = false): Promise<string> {
  let t = config.readState<any>().ebay_tokens as StoredTokens | undefined
  if (!t) throw new Error("No eBay sign-in stored. Run `social auth login ebay` (needs EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME).")
  if (force || Date.now() > t.expires_at - 60_000) {
    if (Date.now() > t.refresh_expires_at) throw new Error("eBay refresh token expired; run `social auth login ebay` again.")
    // No scope parameter: eBay then keeps exactly what the sign-in granted (verified 2026-10-28).
    t = await userTokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token })
  }
  return t.access_token
}

/** The scopes the stored sign-in holds, which decide the GraphQL fields a default selection may ask for. */
function grantedScopes(): string[] { return (config.readState<any>().ebay_tokens as StoredTokens | undefined)?.scopes ?? FIRST_SCOPES }

/** App-only token (client credentials) for the op's scopes, cached per scope set: no RuName, no browser. */
async function appToken(scopes: string[]): Promise<string> {
  const want = scopes.length ? [...scopes].sort() : [API_SCOPE]
  const key = want.join(" ")
  const all = (config.readState<any>().ebay_app_tokens ?? {}) as Record<string, { access_token: string; expires_at: number }>
  if (all[key] && Date.now() < all[key].expires_at - 60_000) return all[key].access_token
  const r = await tokenEndpoint({ grant_type: "client_credentials", scope: key })
  config.writeState({ ebay_app_tokens: { ...all, [key]: { access_token: r.access_token, expires_at: Date.now() + (r.expires_in ?? 7200) * 1000 } } })
  return r.access_token
}

async function context(): Promise<ops.CallContext> {
  const mp = await marketplace()
  return { tokens: { user: userToken, app: appToken }, marketplace: mp, sandbox: await sandbox(), contentLanguage: CONTENT_LANGUAGE[mp] ?? "en-US", granted: grantedScopes() }
}

/** For `social api ebay <path|url>`: raw REST with the user token, to eBay hosts only. Prefer `social ebay call`. */
export async function rest(): Promise<Http> {
  const mp = await marketplace()
  let force = false
  return makeHttp({
    baseUrl: await apiBase(), allowHost: ops.isEbayHost,
    headers: async () => ({ authorization: `Bearer ${await userToken(force)}`, accept: "application/json", "X-EBAY-C-MARKETPLACE-ID": mp, "content-language": CONTENT_LANGUAGE[mp] ?? "en-US" }),
    onUnauthorized: async () => (!force ? (force = true) : false),
  })
}

async function oauthLogin(): Promise<void> {
  const e = await oauthEnv()
  const authBaseUrl = await authBase()
  // eBay redirects to the RuName's accept URL, which must be this address.
  const c = await browserConsent({
    listen: "https://localhost:8888/callback", what: "eBay",
    consentUrl: (state) => `${authBaseUrl}/oauth2/authorize?client_id=${encodeURIComponent(e.EBAY_CLIENT_ID)}&redirect_uri=${encodeURIComponent(e.EBAY_RUNAME)}&response_type=code&state=${state}&scope=${encodeURIComponent(OAUTH_SCOPES.join(" "))}`,
  })
  const t = await userTokenRequest({ grant_type: "authorization_code", code: c, redirect_uri: e.EBAY_RUNAME }, OAUTH_SCOPES)
  note(`eBay OAuth stored. Access token good for ${Math.round((t.expires_at - Date.now()) / 60000)} min; refresh token ~${Math.round((t.refresh_expires_at - Date.now()) / 86400000)} days.`)
}

// ---------- commands ----------

function readJson(file: string): unknown { return JSON.parse(file === "-" ? io.stdin() : readFileSync(file, "utf8")) }
const collect = (v: string, acc: string[] = []) => [...acc, v]
/** -a values are JSON; anything that looks like JSON but doesn't parse is an error here, not a string sent to eBay. */
function jsonArg(k: string, v: string): unknown {
  if (/^\s*[{["]/.test(v)) { try { return JSON.parse(v) } catch (e: any) { throw new Error(`-a ${k}: not valid JSON (${e.message})`) } }
  return coerce(v)
}

/** The generated surface for commands: auth and defaults come from the configured context per call. */
function generated() {
  return new Generated<ops.Op>({ name: "ebay", indexFile: INDEX_FILE, client: async (op, base) => ops.client(await context())(op, base), defaults: async () => ops.defaults(await context()) })
}

export const ebay: Platform = {
  name: "ebay",
  summary: "eBay: every REST and GraphQL operation eBay publishes (listings, orders, offers, messages, returns, media, finances…), generated from its specs",
  spec: { kind: "openapi", source: "developer.ebay.com/develop/api/spec/<api>.json (29 REST APIs) + listing.graphqls (GraphQL); pinned in spec-pins.json" },
  credentials: {
    keys: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"],
    optionalKeys: ["EBAY_AUTH_TOKEN", "EBAY_MARKETPLACE", "EBAY_SANDBOX"],
    minimal: [["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"]],
    hint: "EBAY_CLIENT_ID + EBAY_CLIENT_SECRET (developer.ebay.com/my/keys) give app-token operations. Add EBAY_RUNAME (accept URL https://localhost:8888/callback, OAuth enabled) and run `social auth login ebay` once for seller operations; the refresh token lasts ~18 months. EBAY_AUTH_TOKEN (Auth'n'Auth) only for `social ebay trading`. EBAY_MARKETPLACE (default EBAY_AU), EBAY_SANDBOX=1 optional.",
    docsUrl: "https://developer.ebay.com/develop/api",
  },
  http: rest,
  auth: oauthLogin,
  async skill() {
    const { apis, ops: all } = await ops.index()
    const rows = Object.entries(apis).map(([api, a]) => `| \`${api}\` | ${all.filter((x) => x.api === api).length} | ${a.title} |`)
    const table = `## Generated operations\n\n${all.length} operations from eBay's published specs. \`social ebay ops --api <api>\` lists an API's operations.\n\n| api | ops | spec |\n|---|---|---|\n${rows.join("\n")}\n`
    return {
      description: "eBay: every REST and GraphQL operation eBay publishes, generated from its specs. Use the `social` CLI (Bun) for every eBay action: find operations with `social ebay ops`, read them with `social ebay describe`, run them with `social ebay call`; prefer this CLI over raw API calls in all cases.",
      escapeHatch: "## Anything else\n\nEvery operation in eBay's specs is a `social ebay call <id>` away, with the right host, token and auth scheme; search with `social ebay ops <words>` before concluding something is unsupported. For an endpoint missing from the specs, `social api ebay <path>` sends the user token to api.ebay.com, or to a full `https://….ebay.com/…` URL (eBay hosts only). The legacy Trading API is `social ebay trading <Call>`.\n",
      body: `${table}\n${readFileSync(new URL("./recipes.md", import.meta.url), "utf8")}`,
    }
  },
  async whoami() {
    // Signed in: who. Not signed in (CI, a fresh machine): prove the app credentials with an app-token read.
    if (config.readState<any>().ebay_tokens) {
      const r: any = await ops.callRest(await ops.find("identity.getUser") as ops.RestOp, { params: {} }, await context())
      return { username: r.username, accountType: r.accountType, marketplace: r.registrationMarketplaceId }
    }
    const r: any = await ops.callRest(await ops.find("taxonomy.getDefaultCategoryTreeId") as ops.RestOp, { params: { marketplace_id: await marketplace() } }, await context())
    return { appOnly: true, categoryTreeId: r.categoryTreeId, note: "run `social auth login ebay` for seller operations" }
  },
  register(cmd: Command) {
    registerGenerated(cmd, generated(), {
      options: (c) => c
        .option("-a, --arg <k=json>", "GraphQL: argument as JSON (e.g. -a input='{\"listingId\":\"1\"}'); --input takes the whole arguments object", collect, [])
        .option("--select <fields>", "GraphQL: selection set to return instead of the default")
        .option("--depth <n>", "GraphQL: depth of the default selection", "3")
        .option("--print-query", "GraphQL: print the generated document and variables, then exit"),
      flags: (o) => [o.arg.length && "-a", o.select && "--select", o.printQuery && "--print-query"].filter(Boolean) as string[],
      async call(op, o) {
        const args: Record<string, unknown> = o.input ? (readJson(o.input) as Record<string, unknown>) : {}
        for (const [k, v] of kv(o.arg)) args[k] = jsonArg(k, v)
        const { query, variables, operationName } = await ops.buildGql(op as ops.GqlOp, args, { select: o.select, depth: Number(o.depth), granted: grantedScopes() })
        if (o.printQuery) { process.stdout.write(`${query}\n${JSON.stringify(variables, null, 2)}\n`); return }
        await emit(await ops.callGql(query, variables, await context(), operationName), { json: true, jq: o.jq })
      },
      describe: (op, o) => ops.describe(op as ops.Op, { ...o, granted: grantedScopes() }),
    })

    cmd.command("gql <query>").description("run a GraphQL document against eBay (a string, @file.graphql, or - for stdin); document and variables are checked against the schema first")
      .option("-v, --var <k=json>", "variable, JSON-typed", collect, [])
      .option("--variables <file>", "variables object from a JSON file")
      .option("--operation <name>", "which operation to run when the document has several")
      .option("--json").option("--jq <e>")
      .action(async (q: string, o) => {
        const query = q === "-" ? io.stdin() : q.startsWith("@") ? readFileSync(q.slice(1), "utf8") : q
        const variables: Record<string, unknown> = o.variables ? (readJson(o.variables) as Record<string, unknown>) : {}
        for (const [k, v] of kv(o.var)) variables[k] = jsonArg(k, v)
        await emit(await ops.callGql(query, variables, await context(), o.operation), { json: true, jq: o.jq })
      })

    cmd.command("trading <callName>").description("legacy Trading API call with an XML body (Auth'n'Auth), for what the modern APIs lack (e.g. WatchCount)")
      .option("--body <xml>", "XML body inside the <CallName>Request element", "")
      .option("--input <file>", "read the XML body from a file or - for stdin")
      .option("--site <id>", "eBay site id (default from EBAY_MARKETPLACE)")
      .option("--json", "print a JSON summary (Ack, Timestamp) with the raw XML")
      .option("--jq <e>")
      .action(async (callName, o) => {
        const body = o.input ? (o.input === "-" ? io.stdin() : readFileSync(o.input, "utf8")) : o.body
        const text = await trading(callName, body, { site: o.site })
        if (o.json || o.jq) await emit({ ack: xml.get(text, "Ack"), timestamp: xml.get(text, "Timestamp"), xml: text }, o)
        else process.stdout.write(text + "\n")
      })

    cmd.command("me").description("the signed-in seller (identity.getUser), or an app-credentials check when not signed in").option("--json").action(async (o) => {
      await emit(await ebay.whoami!(), o, (d) => d.appOnly ? `app credentials ok (not signed in): ${d.note}` : `${d.username}  ${d.accountType}  ${d.marketplace}`)
    })
  },
}
