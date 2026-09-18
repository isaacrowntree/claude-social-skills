/**
 * eBay. Two APIs, two auth paths, one command surface.
 *
 *   Trading API (XML, legacy)  ← Auth'n'Auth token. One token pasted once, no redirect
 *     server, works from a laptop. Covers listing (AddFixedPriceItem), revising, picture
 *     upload to eBay's host, My eBay, messages, Best Offers. (Its category and
 *     item-specifics calls were retired by eBay: HTTP 410. Those now use the Taxonomy
 *     REST API with an app-only token, still no user sign-in or redirect server.)
 *     This is the everyday path for local use.
 *   Sell REST APIs (JSON)      ← OAuth 2.0 user token. Needs an app + a RuName redirect,
 *     served here over https://localhost:8888 with a self-signed cert. Covers Inventory,
 *     Marketing, Fulfillment, Account, Negotiation. Use for what Trading cannot do.
 *
 * Both are reachable generically: `social ebay api <CallName> …` (Trading) and
 * `social api ebay <path> …` (REST). The curated commands wrap the calls you use daily.
 *
 * Spec: eBay publishes OpenAPI 3 contracts per Sell API, but developer.ebay.com serves
 * 403 to non-browser fetches, so they are vendored by hand under specs/ebay/ when needed.
 */
import type { Command } from "commander"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, ApiError, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit, note } from "../../core/output.ts"

const TRADING_VERSION = "1349"
const SITE_IDS: Record<string, string> = { EBAY_US: "0", EBAY_GB: "3", EBAY_AU: "15", EBAY_DE: "77", EBAY_CA: "2" }
const OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.negotiation",
]

async function sandbox() { return ["1", "true", "yes"].includes((await config.get("EBAY_SANDBOX") ?? "").toLowerCase()) }
async function apiBase() { return (await sandbox()) ? "https://api.sandbox.ebay.com" : "https://api.ebay.com" }
async function authBase() { return (await sandbox()) ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com" }
async function marketplace() { return (await config.get("EBAY_MARKETPLACE")) ?? "EBAY_AU" }

// ---------- Trading (Auth'n'Auth) ----------

export const xml = {
  esc: (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  // Tags may carry attributes (<CurrentPrice currencyID="AUD">599.0</CurrentPrice>), so match `<Tag` + optional attrs.
  get: (text: string, tag: string) => text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? "",
  all: (text: string, tag: string) => [...text.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]),
  attr: (text: string, tag: string, attr: string) => text.match(new RegExp(`<${tag}\\s[^>]*\\b${attr}="([^"]*)"`))?.[1] ?? "",
}

export async function trading(callName: string, body: string, opts: { site?: string } = {}): Promise<string> {
  const { EBAY_AUTH_TOKEN } = await config.require(["EBAY_AUTH_TOKEN"], "Get a User Token (Auth'n'Auth) at https://developer.ebay.com/my/auth?env=production&index=0&auth_type=auth. Nothing else is needed for the Trading API.")
  const site = opts.site ?? SITE_IDS[await marketplace()] ?? "0"
  const http = makeHttp({ baseUrl: (await apiBase()) + "/ws" })
  const req = `<?xml version="1.0" encoding="utf-8"?>\n<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xml.esc(EBAY_AUTH_TOKEN)}</eBayAuthToken></RequesterCredentials>${body}</${callName}Request>`
  const text = await http.request<string>({
    method: "POST", path: "api.dll", raw: true, body: req,
    headers: { "content-type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_VERSION, "X-EBAY-API-CALL-NAME": callName, "X-EBAY-API-SITEID": site },
  })
  const ack = xml.get(text, "Ack")
  if (ack === "Failure") {
    const errs = xml.all(text, "Errors").map((e) => `${xml.get(e, "ErrorCode")}: ${xml.get(e, "LongMessage") || xml.get(e, "ShortMessage")}`)
    throw new ApiError(200, `Trading ${callName} failed:\n${errs.join("\n")}`, "api.dll", "POST")
  }
  return text
}

/** Upload a local image to eBay's picture host; returns the hosted URL. Trading-only capability. */
export async function uploadPicture(file: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const { EBAY_AUTH_TOKEN } = await config.require(["EBAY_AUTH_TOKEN"], "UploadSiteHostedPictures needs an Auth'n'Auth token.")
  const boundary = "----social" + Date.now()
  const xmlPart = `<?xml version="1.0" encoding="utf-8"?><UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xml.esc(EBAY_AUTH_TOKEN)}</eBayAuthToken></RequesterCredentials><PictureName>${xml.esc(file.split("/").pop())}</PictureName><PictureSet>Supersize</PictureSet></UploadSiteHostedPicturesRequest>`
  const enc = new TextEncoder()
  const parts = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml; charset=utf-8\r\n\r\n${xmlPart}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="dummy"; filename="${file.split("/").pop()}"\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n`),
    bytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  ]
  const body = new Blob(parts as BlobPart[])
  const http = makeHttp({ baseUrl: (await apiBase()) + "/ws" })
  const text = await http.request<string>({
    method: "POST", path: "api.dll", raw: true, body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_VERSION, "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures", "X-EBAY-API-SITEID": "0" },
  })
  if (xml.get(text, "Ack") === "Failure") throw new Error(`UploadSiteHostedPictures failed: ${xml.get(text, "LongMessage")}`)
  return xml.get(text, "FullURL")
}

// ---------- REST (OAuth) ----------

interface Tokens { access_token: string; refresh_token: string; expires_at: number; refresh_expires_at: number }

async function oauthEnv() {
  return config.require(["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"], "Create an app at https://developer.ebay.com/my/keys, add a RuName whose accept URL is https://localhost:8888/callback, then `social auth login ebay`.")
}
function basic(id: string, secret: string) { return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") }

async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const e = await oauthEnv()
  const http = makeHttp({ baseUrl: await apiBase() })
  const r = await http.request<any>({ method: "POST", path: "identity/v1/oauth2/token", form, headers: { authorization: basic(e.EBAY_CLIENT_ID, e.EBAY_CLIENT_SECRET) } })
  const now = Date.now()
  const prev = (config.readState<any>().ebay_tokens ?? {}) as Partial<Tokens>
  const t: Tokens = {
    access_token: r.access_token,
    refresh_token: r.refresh_token ?? prev.refresh_token!,
    expires_at: now + (r.expires_in ?? 7200) * 1000,
    refresh_expires_at: r.refresh_token_expires_in ? now + r.refresh_token_expires_in * 1000 : prev.refresh_expires_at ?? 0,
  }
  config.writeState({ ebay_tokens: t })
  return t
}

async function accessToken(): Promise<string> {
  let t = config.readState<any>().ebay_tokens as Tokens | undefined
  if (!t) throw new Error("No eBay OAuth tokens stored. Run `social auth login ebay` (needs EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME).")
  if (Date.now() > t.expires_at - 60_000) {
    if (Date.now() > t.refresh_expires_at) throw new Error("eBay refresh token expired; run `social auth login ebay` again.")
    const e = await oauthEnv()
    t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, scope: OAUTH_SCOPES.join(" ") })
    void e
  }
  return t.access_token
}

/**
 * App-only token (client credentials). Enough for the Commerce Taxonomy API, which
 * replaced the retired Trading category calls. Needs only EBAY_CLIENT_ID/SECRET;
 * no RuName, no browser, no redirect server.
 */
async function appToken(): Promise<string> {
  const st = config.readState<any>().ebay_app_token as { access_token: string; expires_at: number } | undefined
  if (st && Date.now() < st.expires_at - 60_000) return st.access_token
  const e = await config.require(["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"], "Category lookups use the Taxonomy API, which needs your app's client id and secret from https://developer.ebay.com/my/keys (no user sign-in required).")
  const http = makeHttp({ baseUrl: await apiBase() })
  const r = await http.request<any>({ method: "POST", path: "identity/v1/oauth2/token", form: { grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }, headers: { authorization: basic(e.EBAY_CLIENT_ID, e.EBAY_CLIENT_SECRET) } })
  config.writeState({ ebay_app_token: { access_token: r.access_token, expires_at: Date.now() + (r.expires_in ?? 7200) * 1000 } })
  return r.access_token
}

const TREE_IDS: Record<string, string> = { EBAY_US: "0", EBAY_GB: "3", EBAY_AU: "15", EBAY_DE: "77", EBAY_CA: "2" }

async function taxonomy(): Promise<Http> {
  return makeHttp({ baseUrl: (await apiBase()) + "/commerce/taxonomy/v1", headers: async () => ({ authorization: `Bearer ${await appToken()}`, accept: "application/json" }) })
}

export async function rest(): Promise<Http> {
  const mp = await marketplace()
  return makeHttp({
    baseUrl: await apiBase(),
    headers: async () => ({ authorization: `Bearer ${await accessToken()}`, accept: "application/json", "X-EBAY-C-MARKETPLACE-ID": mp, "content-language": "en-AU" }),
  })
}

async function oauthLogin(): Promise<void> {
  const e = await oauthEnv()
  const dir = mkdtempSync(join(tmpdir(), "social-ebay-"))
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem")
  const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost"])
  if (gen.exitCode !== 0) throw new Error("openssl is needed to serve the https://localhost:8888 callback")
  let resolveCode!: (c: string) => void
  const code = new Promise<string>((r) => (resolveCode = r))
  const server = Bun.serve({
    port: 8888, hostname: "localhost", tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch(req) {
      const u = new URL(req.url)
      const c = u.searchParams.get("code")
      if (c) { resolveCode(c); return new Response("<h1>Authorised. You can close this tab.</h1>", { headers: { "content-type": "text/html" } }) }
      return new Response(`<h1>Authorisation failed: ${u.searchParams.get("error") ?? "unknown"}</h1>`, { status: 400, headers: { "content-type": "text/html" } })
    },
  })
  const url = `${await authBase()}/oauth2/authorize?client_id=${encodeURIComponent(e.EBAY_CLIENT_ID)}&redirect_uri=${encodeURIComponent(e.EBAY_RUNAME)}&response_type=code&scope=${encodeURIComponent(OAUTH_SCOPES.join(" "))}`
  note(`Opening the browser for eBay authorisation. Accept the self-signed certificate warning for localhost.\n${url}`)
  Bun.spawn(["open", url])
  const c = await Promise.race([code, Bun.sleep(180_000).then(() => { throw new Error("timed out waiting for the eBay callback") })])
  server.stop(true)
  const t = await tokenRequest({ grant_type: "authorization_code", code: c, redirect_uri: e.EBAY_RUNAME })
  note(`eBay OAuth stored. Access token good for ${Math.round((t.expires_at - Date.now()) / 60000)} min; refresh token ~${Math.round((t.refresh_expires_at - Date.now()) / 86400000)} days.`)
}

// ---------- listing helpers (Trading) ----------

export const CONDITION_IDS: Record<string, number> = { NEW: 1000, NEW_OTHER: 1500, NEW_WITH_DEFECTS: 1750, CERTIFIED_REFURBISHED: 2000, SELLER_REFURBISHED: 2500, LIKE_NEW: 2750, USED_EXCELLENT: 3000, USED_VERY_GOOD: 4000, USED_GOOD: 5000, USED_ACCEPTABLE: 6000, FOR_PARTS_OR_NOT_WORKING: 7000 }

export interface Listing {
  title: string; description: string; price: number; currency?: string; categoryId: string
  condition: keyof typeof CONDITION_IDS; conditionDescription?: string; quantity?: number; sku?: string
  images: string[]; format?: "FixedPrice" | "Auction"; durationDays?: number
  postcode: string; location: string; country?: string
  shipping: { service: string; cost: number; type?: "Flat" | "Calculated" }[]; dispatchDays?: number
  returns?: { accepted: boolean; days?: number; paidBy?: "Buyer" | "Seller" }
  specifics?: Record<string, string>; bestOffer?: { enabled: boolean; autoAccept?: number; autoDecline?: number }
  galleryPlus?: boolean
}

export function listingXml(l: Listing): string {
  const e = xml.esc
  const cur = l.currency ?? "AUD"
  const pics = l.images.map((u) => `<PictureURL>${e(u)}</PictureURL>`).join("")
  const ship = l.shipping.map((s, i) => `<ShippingServiceOptions><ShippingServicePriority>${i + 1}</ShippingServicePriority><ShippingService>${e(s.service)}</ShippingService><ShippingServiceCost currencyID="${cur}">${s.cost.toFixed(2)}</ShippingServiceCost></ShippingServiceOptions>`).join("")
  const specifics = l.specifics ? `<ItemSpecifics>${Object.entries(l.specifics).map(([k, v]) => `<NameValueList><Name>${e(k)}</Name><Value>${e(v)}</Value></NameValueList>`).join("")}</ItemSpecifics>` : ""
  const returns = l.returns?.accepted
    ? `<ReturnPolicy><ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption><ReturnsWithinOption>Days_${l.returns.days ?? 30}</ReturnsWithinOption><ShippingCostPaidByOption>${l.returns.paidBy ?? "Buyer"}</ShippingCostPaidByOption></ReturnPolicy>`
    : `<ReturnPolicy><ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption></ReturnPolicy>`
  const bo = l.bestOffer?.enabled ? `<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>${l.bestOffer.autoAccept || l.bestOffer.autoDecline ? `<ListingDetails>${l.bestOffer.autoAccept ? `<BestOfferAutoAcceptPrice currencyID="${cur}">${l.bestOffer.autoAccept.toFixed(2)}</BestOfferAutoAcceptPrice>` : ""}${l.bestOffer.autoDecline ? `<MinimumBestOfferPrice currencyID="${cur}">${l.bestOffer.autoDecline.toFixed(2)}</MinimumBestOfferPrice>` : ""}</ListingDetails>` : ""}` : ""
  const isAuction = l.format === "Auction"
  return `<Item>
<Title>${e(l.title)}</Title><Description><![CDATA[${l.description}]]></Description>
<PrimaryCategory><CategoryID>${e(l.categoryId)}</CategoryID></PrimaryCategory>
<${isAuction ? "StartPrice" : "StartPrice"} currencyID="${cur}">${l.price.toFixed(2)}</StartPrice>
<ConditionID>${CONDITION_IDS[l.condition]}</ConditionID>${l.conditionDescription ? `<ConditionDescription>${e(l.conditionDescription)}</ConditionDescription>` : ""}
<Country>${l.country ?? "AU"}</Country><Currency>${cur}</Currency>
<DispatchTimeMax>${l.dispatchDays ?? 3}</DispatchTimeMax>
<ListingDuration>${isAuction ? `Days_${l.durationDays ?? 7}` : "GTC"}</ListingDuration>
<ListingType>${isAuction ? "Chinese" : "FixedPriceItem"}</ListingType>
<Location>${e(l.location)}</Location><PostalCode>${e(l.postcode)}</PostalCode>
<PictureDetails>${l.galleryPlus ? "<GalleryType>Plus</GalleryType>" : ""}${pics}</PictureDetails>
<Quantity>${l.quantity ?? 1}</Quantity>${l.sku ? `<SKU>${e(l.sku)}</SKU>` : ""}
${returns}
<ShippingDetails><ShippingType>${l.shipping[0]?.type ?? "Flat"}</ShippingType>${ship}</ShippingDetails>
${specifics}${bo}
</Item>`
}

async function resolveImages(images: string[]): Promise<string[]> {
  const out: string[] = []
  for (const i of images) {
    if (/^https?:\/\//.test(i)) out.push(i)
    else if (existsSync(i)) { note(`uploading ${i} to eBay's picture host`); out.push(await uploadPicture(i)) }
    else throw new Error(`image not found: ${i}`)
  }
  return out
}

// ---------- platform ----------

export const ebay: Platform = {
  name: "ebay",
  summary: "eBay: list, revise, messages, offers, categories (Trading, Auth'n'Auth) and any Sell REST API (OAuth)",
  spec: { kind: "openapi", source: "https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json (vendored: the host blocks non-browser fetches)" },
  credentials: { keys: ["EBAY_AUTH_TOKEN"], hint: "Auth'n'Auth user token for the Trading API (listing, messages, offers). EBAY_CLIENT_ID + EBAY_CLIENT_SECRET add category/specifics lookups (app-only token, no sign-in). Add EBAY_RUNAME and run `social auth login ebay` only for the user-scoped Sell REST APIs. EBAY_MARKETPLACE (default EBAY_AU), EBAY_SANDBOX=1 optional.", docsUrl: "https://developer.ebay.com/develop/apis" },
  http: rest,
  auth: oauthLogin,
  async whoami() {
    const t = await trading("GetUser", "<DetailLevel>ReturnAll</DetailLevel>")
    return { userId: xml.get(t, "UserID"), site: xml.get(t, "Site"), feedback: xml.get(t, "FeedbackScore") }
  },
  register(cmd: Command) {
    cmd.command("api <callName>").description("call any Trading API operation with the XML body (Auth'n'Auth)")
      .option("--body <xml>", "XML body inside the <CallName>Request element", "")
      .option("--input <file>", "read the XML body from a file or - for stdin")
      .option("--site <id>", "eBay site id (default from EBAY_MARKETPLACE)")
      .option("--json", "print a JSON summary (Ack, Errors, Timestamp) instead of raw XML")
      .option("--jq <e>")
      .action(async (callName, o) => {
        const body = o.input ? (o.input === "-" ? await Bun.stdin.text() : await Bun.file(o.input).text()) : o.body
        const text = await trading(callName, body, { site: o.site })
        if (o.json || o.jq) await emit({ ack: xml.get(text, "Ack"), timestamp: xml.get(text, "Timestamp"), xml: text }, o)
        else process.stdout.write(text + "\n")
      })

    cmd.command("me").description("the authenticated seller (GetUser)").option("--json").action(async (o) => { await emit(await ebay.whoami!(), o, (d) => `${d.userId}  site ${d.site}  feedback ${d.feedback}`) })

    cmd.command("selling").description("your active listings (GetMyeBaySelling)").option("-n, --max <n>", "per page", "50").option("--json").option("--jq <e>")
      .action(async (o) => {
        const t = await trading("GetMyeBaySelling", `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>${Number(o.max)}</EntriesPerPage></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`)
        const items = xml.all(t, "Item").map((i) => ({ itemId: xml.get(i, "ItemID"), title: xml.get(i, "Title"), price: xml.get(i, "CurrentPrice"), quantity: xml.get(i, "QuantityAvailable") || xml.get(i, "Quantity"), watchers: xml.get(i, "WatchCount"), url: xml.get(i, "ViewItemURL") }))
        await emit(items, o, (d) => d.map((i: any) => `${i.itemId}  ${i.price.padStart(8)}  ${i.title}`).join("\n") || "(no active listings)")
      })

    cmd.command("item <itemId>").description("one listing in full (GetItem)").option("--json").option("--jq <e>").action(async (id, o) => {
      const t = await trading("GetItem", `<ItemID>${xml.esc(id)}</ItemID><DetailLevel>ReturnAll</DetailLevel>`)
      await emit({ itemId: id, title: xml.get(t, "Title"), price: xml.get(t, "CurrentPrice"), quantity: xml.get(t, "Quantity"), sold: xml.get(t, "QuantitySold"), condition: xml.get(t, "ConditionDisplayName"), url: xml.get(t, "ViewItemURL"), xml: t }, o, (d) => `${d.title}\n${d.price}  qty ${d.quantity} sold ${d.sold}  ${d.condition}\n${d.url}`)
    })

    cmd.command("messages").description("recent buyer messages (GetMyMessages)").option("--days <n>", "look back", "7").option("--json").option("--jq <e>").action(async (o) => {
      const since = new Date(Date.now() - Number(o.days) * 86400000).toISOString()
      const t = await trading("GetMyMessages", `<DetailLevel>ReturnHeaders</DetailLevel><StartTime>${since}</StartTime>`)
      const msgs = xml.all(t, "Message").map((m) => ({ id: xml.get(m, "MessageID"), from: xml.get(m, "Sender"), subject: xml.get(m, "Subject"), received: xml.get(m, "ReceiveDate"), read: xml.get(m, "Read") === "true", itemId: xml.get(m, "ItemID") }))
      await emit(msgs, o, (d) => d.map((m: any) => `${m.read ? " " : "*"} ${m.received.slice(0, 10)}  ${m.from.padEnd(18)}  ${m.subject}`).join("\n") || "(no messages)")
    })

    cmd.command("offers").description("pending Best Offers on your listings (GetBestOffers)").option("--item <id>", "only this item").option("--json").option("--jq <e>").action(async (o) => {
      const t = await trading("GetBestOffers", `${o.item ? `<ItemID>${xml.esc(o.item)}</ItemID>` : ""}<BestOfferStatus>Active</BestOfferStatus><DetailLevel>ReturnAll</DetailLevel>`)
      const offers = xml.all(t, "BestOffer").map((b) => ({ offerId: xml.get(b, "BestOfferID"), itemId: xml.get(t, "ItemID"), price: xml.get(b, "Price"), buyer: xml.get(b, "UserID"), quantity: xml.get(b, "Quantity"), message: xml.get(b, "BuyerMessage"), expires: xml.get(b, "ExpirationTime") }))
      await emit(offers, o, (d) => d.map((x: any) => `${x.offerId}  ${x.price}  ${x.buyer}  ${x.message}`).join("\n") || "(no offers)")
    })

    cmd.command("respond <itemId> <offerId> <action>").description("accept | decline | counter a Best Offer").option("--counter <price>").option("--message <text>").option("--json").action(async (itemId, offerId, action, o) => {
      const a = { accept: "Accept", decline: "Decline", counter: "Counter" }[action as string]
      if (!a) throw new Error("action must be accept, decline or counter")
      if (a === "Counter" && !o.counter) throw new Error("--counter <price> is required for counter")
      const body = `<ItemID>${xml.esc(itemId)}</ItemID><BestOfferID>${xml.esc(offerId)}</BestOfferID><Action>${a}</Action>${o.counter ? `<CounterOfferPrice currencyID="AUD">${Number(o.counter).toFixed(2)}</CounterOfferPrice><CounterOfferQuantity>1</CounterOfferQuantity>` : ""}${o.message ? `<SellerResponse>${xml.esc(o.message)}</SellerResponse>` : ""}`
      const t = await trading("RespondToBestOffer", body)
      await emit({ ack: xml.get(t, "Ack") }, o, (d) => `${a}: ${d.ack}`)
    })

    // GetCategories / GetCategorySpecifics / GetSuggestedCategories return HTTP 410 from the
    // Trading API (verified 2026-09-18). The Commerce Taxonomy API replaces them.
    cmd.command("categories <query>").description("suggest leaf categories for a listing title (Taxonomy getCategorySuggestions)").option("--json").option("--jq <e>").action(async (query, o) => {
      const t = await taxonomy(); const tree = TREE_IDS[await marketplace()] ?? "0"
      const r = await t.request<any>({ path: `category_tree/${tree}/get_category_suggestions`, query: { q: query } })
      const hits = (r.categorySuggestions ?? []).map((c: any) => ({ id: c.category.categoryId, name: c.category.categoryName, path: [...(c.categoryTreeNodeAncestors ?? [])].reverse().map((a: any) => a.categoryName).concat(c.category.categoryName).join(" > "), relevancy: c.relevancy }))
      await emit(hits, o, (d) => d.map((c: any) => `${String(c.id).padStart(7)}  ${c.path}`).join("\n") || "(no suggestions)")
    })

    cmd.command("specifics <categoryId>").description("required and recommended item specifics for a category (Taxonomy getItemAspectsForCategory)").option("--json").option("--jq <e>").action(async (id, o) => {
      const t = await taxonomy(); const tree = TREE_IDS[await marketplace()] ?? "0"
      const r = await t.request<any>({ path: `category_tree/${tree}/get_item_aspects_for_category`, query: { category_id: id } })
      const names = (r.aspects ?? []).map((a: any) => ({ name: a.localizedAspectName, required: !!a.aspectConstraint?.aspectRequired, mode: a.aspectConstraint?.aspectMode, values: (a.aspectValues ?? []).slice(0, 12).map((v: any) => v.localizedValue) }))
      await emit(names, o, (d) => d.map((n: any) => `${n.required ? "*" : " "} ${n.name.padEnd(28)} ${n.values.join(", ")}`).join("\n"))
    })

    cmd.command("list").description("create a listing from a JSON file (see `social ebay list --example`); local image paths are uploaded to eBay")
      .option("--input <file>", "listing JSON, or - for stdin").option("--verify", "VerifyAddFixedPriceItem only; nothing is created").option("--example", "print an example listing JSON").option("--json")
      .action(async (o) => {
        if (o.example) { process.stdout.write(JSON.stringify(EXAMPLE, null, 2) + "\n"); return }
        if (!o.input) throw new Error("--input <file> is required (or --example)")
        const l: Listing = JSON.parse(o.input === "-" ? await Bun.stdin.text() : await Bun.file(o.input).text())
        for (const k of ["title", "description", "price", "categoryId", "condition", "images", "postcode", "location", "shipping"] as const) if (l[k] === undefined) throw new Error(`listing is missing "${k}"`)
        l.images = await resolveImages(l.images)
        const call = o.verify ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem"
        const t = await trading(call, listingXml(l))
        const fees = xml.all(t, "Fee").map((f) => ({ name: xml.get(f, "Name"), amount: xml.get(f, "Fee") })).filter((f) => Number(f.amount) > 0)
        const res = { itemId: xml.get(t, "ItemID"), ack: xml.get(t, "Ack"), fees, url: xml.get(t, "ItemID") ? `https://www.ebay.com.au/itm/${xml.get(t, "ItemID")}` : undefined, warnings: xml.all(t, "Errors").map((e) => xml.get(e, "LongMessage")) }
        await emit(res, o, (d) => `${o.verify ? "verified" : "listed"}: ${d.ack}${d.itemId ? `  ${d.url}` : ""}\nfees: ${d.fees.map((f: any) => `${f.name} ${f.amount}`).join(", ") || "none"}${d.warnings.length ? "\nwarnings: " + d.warnings.join("; ") : ""}`)
      })

    cmd.command("revise <itemId>").description("change price and/or quantity on a live listing (ReviseFixedPriceItem)").option("--price <n>").option("--quantity <n>").option("--title <t>").option("--json")
      .action(async (id, o) => {
        const fields = [o.price ? `<StartPrice>${Number(o.price).toFixed(2)}</StartPrice>` : "", o.quantity ? `<Quantity>${Number(o.quantity)}</Quantity>` : "", o.title ? `<Title>${xml.esc(o.title)}</Title>` : ""].join("")
        if (!fields) throw new Error("nothing to revise; pass --price, --quantity or --title")
        const t = await trading("ReviseFixedPriceItem", `<Item><ItemID>${xml.esc(id)}</ItemID>${fields}</Item>`)
        await emit({ ack: xml.get(t, "Ack") }, o, (d) => `revised: ${d.ack}`)
      })

    cmd.command("upload <files...>").description("upload local images to eBay's picture host; prints URLs for listing JSON").option("--json").action(async (files, o) => {
      const urls: string[] = []; for (const f of files) urls.push(await uploadPicture(f))
      await emit(urls, o, (d) => d.join("\n"))
    })
  },
}

const EXAMPLE: Listing = {
  title: "Sony A7 IV body, boxed, 4,200 shutter count", description: "<p>Excellent condition, from a smoke-free home. Box, strap, charger, two batteries.</p>",
  price: 2450, currency: "AUD", categoryId: "31388", condition: "USED_EXCELLENT", conditionDescription: "Light wear on the grip; sensor clean.",
  quantity: 1, sku: "A7IV-01", images: ["./photos/a7iv-front.jpg", "https://example.com/a7iv-back.jpg"], format: "FixedPrice",
  postcode: "2000", location: "Sydney, NSW", country: "AU",
  shipping: [{ service: "AU_Regular", cost: 15, type: "Flat" }], dispatchDays: 2,
  returns: { accepted: true, days: 30, paidBy: "Buyer" },
  specifics: { Brand: "Sony", Model: "Sony a7 IV", Type: "Mirrorless" },
  bestOffer: { enabled: true, autoAccept: 2300, autoDecline: 1900 }, galleryPlus: false,
}
