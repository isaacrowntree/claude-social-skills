import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildSchema, parse, validate } from "graphql"
import { apiName, brief, gqlOps, restOps, type OpsIndex, type RestOp } from "../src/platforms/ebay/build-index.ts"
import * as ops from "../src/platforms/ebay/ops.ts"

const ctx = { marketplace: "EBAY_AU", sandbox: false, contentLanguage: "en-AU" }

const spec = (paths: any, extra: any = {}) => ({
  servers: [{ url: "https://api.ebay.com{basePath}", variables: { basePath: { default: "/sell/thing/v1" } } }],
  components: { securitySchemes: {
    user: { type: "oauth2", flows: { authorizationCode: { scopes: {} } } },
    app: { type: "oauth2", flows: { clientCredentials: { scopes: {} } } },
  } },
  paths, ...extra,
})

describe("ebay op index (build-index.ts)", () => {
  test("api names drop the _api infix", () => {
    expect(apiName("fulfillment_api")).toBe("fulfillment")
    expect(apiName("account_api_v1")).toBe("account_v1")
    expect(apiName("vero_api_v2")).toBe("vero_v2")
  })

  test("brief keeps sentence breaks across HTML and skips lead-ins", () => {
    expect(brief("Important! This method returns orders for the seller. More text.")).toBe("This method returns orders for the seller.")
    expect(brief("This method gets items in bulk.<br><br>Note: Only some sellers.")).toBe("This method gets items in bulk.")
    expect(brief("<b>Note:</b> Sell Marketing API documentation has been updated to reflect a rename. This method creates a markdown discount.")).toBe("This method creates a markdown discount.")
    expect(brief("See the [docs](https://x) for the full list of things.")).toBe("See the docs for the full list of things.")
    expect(brief("x".repeat(300), 10)).toBe("xxxxxxxxx…")
  })

  test("resolves server variables, params, body and token type", () => {
    const [op] = restOps("thing", spec({ "/item/{id}": { get: {
      operationId: "getItem", summary: "Get one item", security: [{ app: ["https://api.ebay.com/oauth/api_scope"] }],
      parameters: [{ name: "id", in: "path", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer" } }],
    } } }))
    expect(op).toMatchObject({ id: "thing.getItem", method: "GET", server: "https://api.ebay.com/sell/thing/v1", path: "/item/{id}", auth: "app", scheme: "Bearer" })
    expect(op.params.map((p) => [p.name, p.in, p.required])).toEqual([["id", "path", true], ["limit", "query", false]])
  })

  test("token type: app only when every option is client-credentials only; spec-wide security is the fallback", () => {
    const mixed = restOps("thing", spec({ "/x": { get: { operationId: "x", security: [{ app: [] }, { user: [] }] } } }))[0]
    expect(mixed.auth).toBe("user")
    // One scheme offering both flows (most eBay specs) is a user-token op too.
    const both = restOps("thing", spec({ "/x": { get: { operationId: "x", security: [{ both: [] }] } } }, { components: { securitySchemes: { both: { type: "oauth2", flows: { authorizationCode: { scopes: {} }, clientCredentials: { scopes: {} } } } } } }))[0]
    expect(both.auth).toBe("user")
    const empty = restOps("thing", spec({ "/x": { get: { operationId: "x", security: [{}] } } }))[0]
    expect(empty.auth).toBe("user")
    const inherited = restOps("thing", spec({ "/x": { get: { operationId: "x" } } }, { security: [{ app: ["https://api.ebay.com/oauth/api_scope", "eBayUser"] }] }))[0]
    expect(inherited).toMatchObject({ auth: "app", scopes: ["https://api.ebay.com/oauth/api_scope"] })
  })

  test("$ref'd parameters, bodies and parameter schemas resolve; op-level params override path-level ones", () => {
    const [op] = restOps("thing", spec({ "/x": {
      parameters: [{ name: "mode", in: "query", schema: { type: "string" }, description: "path-level" }],
      post: { operationId: "x", parameters: [{ $ref: "#/components/parameters/Mode" }, { name: "sort", in: "query", schema: { type: "array", items: { $ref: "#/components/schemas/Sort" } } }], requestBody: { $ref: "#/components/requestBodies/B" } },
    } }, { components: {
      parameters: { Mode: { name: "mode", in: "query", required: true, schema: { type: "string" }, description: "Operation-level mode." } },
      schemas: { Sort: { type: "string", enum: ["asc", "desc"] } },
      requestBodies: { B: { required: true, content: { "application/json": {} } } },
      securitySchemes: {},
    } }))
    expect(op.params).toEqual([
      { name: "mode", in: "query", required: true, type: "string", description: "Operation-level mode." },
      { name: "sort", in: "query", required: false, type: "asc|desc[]", description: "" },
    ])
    expect(op.body).toEqual({ contentTypes: ["application/json"], required: true })
  })

  test("paths differing only in case (Finances /payout/{payout_Id} and {payout_id}) index once", () => {
    const list = restOps("finances", spec({ "/payout/{payout_Id}": { get: { operationId: "getPayout" } }, "/payout/{payout_id}": { get: { operationId: "getPayout" } } }))
    expect(list).toHaveLength(1)
  })

  test("undeclared path placeholders become required path params (Metadata)", () => {
    const [op] = restOps("thing", spec({ "/marketplace/{marketplace_id}/policies": { get: { operationId: "p" } } }))
    expect(op.params[0]).toMatchObject({ name: "marketplace_id", in: "path", required: true })
  })

  test("base path repeated in the path (Post-Order) or path repeated in the server (Finances) is collapsed", () => {
    const po = restOps("post_order", spec({ "/post-order/v2/return/search": { get: { operationId: "s" } } }, { servers: [{ url: "https://api.ebay.com{basePath}", variables: { basePath: { default: "/post-order/v2" } } }] }))[0]
    expect(po.server + po.path).toBe("https://api.ebay.com/post-order/v2/return/search")
    expect(po.scheme).toBe("IAF")
    const fin = restOps("finances", spec({ "/billing_activity": { servers: [{ url: "https://api.ebay.com{basePath}", variables: { basePath: { default: "/sell/finances/v1/billing_activity" } } }], get: { operationId: "b" } } }))[0]
    expect(fin.server + fin.path).toBe("https://api.ebay.com/sell/finances/v1/billing_activity")
  })

  test("FIXES: hosts replace only the API-wide server; vero is a user-token API", () => {
    const media = restOps("media", spec({
      "/image/create_image_from_file": { post: { operationId: "createImageFromFile" } },
      "/document": { post: { operationId: "createDocument", servers: [{ url: "https://api.ebay.com/commerce/media/v1_beta" }] } },
    }, { servers: [{ url: "https://api.ebay.com/commerce/media/v1_beta" }] }))
    expect(media.find((o) => o.operationId === "createImageFromFile")!.server).toBe("https://apim.ebay.com/commerce/media/v1_beta")
    expect(media.find((o) => o.operationId === "createDocument")!.server).toBe("https://api.ebay.com/commerce/media/v1_beta")
    expect(restOps("fulfillment", spec({ "/order": { get: { operationId: "getOrders" } } }, { servers: [{ url: "https://apiz.ebay.com/sell/fulfillment/v1" }] }))[0].server).toBe("https://api.ebay.com/sell/fulfillment/v1")
    expect(restOps("vero_v2", spec({ "/x": { get: { operationId: "x", security: [{ app: [] }] } } }))[0].auth).toBe("user")
  })

  test("GraphQL root fields become ops with @authorize scopes and searchable input field names", () => {
    const list = gqlOps(`directive @authorize(scopes: [String!]!) on FIELD_DEFINITION
      input PriceIn { fixedPrice: Float }
      input UpdateIn { listingId: ID! pricingTerms: PriceIn }
      type Query { """Find listings. More.""" listings(first: Int): [String] @authorize(scopes: ["https://api.ebay.com/oauth/api_scope/sell.listing"]) }
      type Mutation { update(input: UpdateIn!): Boolean }`)
    expect(list[0]).toMatchObject({ kind: "query", id: "gql.listings", summary: "Find listings.", args: [{ name: "first", type: "Int" }], scopes: ["https://api.ebay.com/oauth/api_scope/sell.listing"] })
    expect(list[1].keywords).toContain("fixedprice")
  })
})

// ---------- runtime ----------

const restOp = (o: Partial<RestOp>): RestOp => ({
  kind: "rest", id: "inventory.update", api: "inventory", operationId: "update", method: "PUT", server: "https://api.ebay.com/sell/inventory/v1",
  path: "/item/{sku}", summary: "", scopes: [], schemes: [], auth: "user", scheme: "Bearer", keywords: "", body: { contentTypes: ["application/json"], required: true },
  params: [
    { name: "sku", in: "path", required: true, type: "string", description: "" },
    { name: "mode", in: "query", required: false, type: "string", description: "" },
    { name: "Content-Language", in: "header", required: true, type: "string", description: "" },
  ], ...o,
})

describe("buildRest", () => {
  const op = restOp({})
  test("fills path, query and default headers; params match case-insensitively", () => {
    const r = ops.buildRest(op, { params: { SKU: "a b", mode: "x" }, body: { q: 1 } }, ctx)
    expect(r).toMatchObject({ baseUrl: "https://api.ebay.com/sell/inventory/v1", method: "PUT", path: "/item/a%20b", query: { mode: "x" }, body: { q: 1 } })
    expect(r.headers).toEqual({ "X-EBAY-C-MARKETPLACE-ID": "EBAY_AU", "Content-Language": "en-AU", "Content-Type": "application/json" })
  })

  test("names the valid parameters when one is unknown, and asks for missing ones", () => {
    expect(() => ops.buildRest(op, { params: { sku: "1", nope: "2" }, body: {} }, ctx)).toThrow(/no parameter "nope".*sku, mode, Content-Language/)
    expect(() => ops.buildRest(op, { params: {}, body: {} }, ctx)).toThrow(/path parameter "sku"/)
    expect(() => ops.buildRest(op, { params: { sku: "1" } }, ctx)).toThrow(/needs a request body/)
    const q = restOp({ method: "GET", body: undefined, path: "/x", params: [{ name: "filter", in: "query", required: true, type: "string", description: "" }] })
    expect(() => ops.buildRest(q, { params: {} }, ctx)).toThrow(/query parameter "filter"/)
  })

  test("marketplace_id path params default to the configured marketplace; sandbox swaps the host", () => {
    const m = restOp({ method: "GET", body: undefined, path: "/marketplace/{marketplace_id}/x", params: [{ name: "marketplace_id", in: "path", required: true, type: "string", description: "" }] })
    expect(ops.buildRest(m, { params: {} }, ctx).path).toBe("/marketplace/EBAY_AU/x")
    expect(ops.buildRest(m, { params: {} }, { ...ctx, sandbox: true }).baseUrl).toBe("https://api.sandbox.ebay.com/sell/inventory/v1")
  })

  test("multipart: FormData with file parts, and a user-supplied Content-Type is dropped (it would lose the boundary)", () => {
    const m = restOp({ method: "POST", path: "/image", params: [{ name: "Content-Type", in: "header", required: true, type: "string", description: "" }], body: { contentTypes: ["multipart/form-data"], required: true } })
    const r = ops.buildRest(m, { params: { "Content-Type": "multipart/form-data" }, files: { image: import.meta.path } }, ctx)
    expect(r.body).toBeInstanceOf(FormData)
    expect(r.headers["Content-Type"]).toBeUndefined()
  })

  test("an octet-stream body is the file itself; --file on a JSON op is refused", () => {
    const v = restOp({ method: "POST", path: "/video/{id}/upload", params: [{ name: "id", in: "path", required: true, type: "string", description: "" }], body: { contentTypes: ["application/octet-stream"], required: true } })
    const r = ops.buildRest(v, { params: { id: "1" }, files: { video: import.meta.path } }, ctx)
    expect(r.body).toBeInstanceOf(Blob)
    expect((r.body as Blob).type).toBe("application/octet-stream")
    expect(() => ops.buildRest(v, { params: { id: "1" } }, ctx)).toThrow(/--file/)
    expect(() => ops.buildRest(op, { params: { sku: "1" }, files: { x: import.meta.path } }, ctx)).toThrow(/not a file/)
  })

  test("sandbox swaps every eBay host family", () => {
    for (const h of ["api", "apiz", "apim", "graphqlapi"]) expect(ops.sandboxUrl(`https://${h}.ebay.com/x`)).toBe(`https://${h}.sandbox.ebay.com/x`)
  })
})

// A fake eBay: records what arrives, answers with whatever the test sets.
interface Seen { method: string; path: string; headers: Record<string, string>; body: any; text: string }
const seen: Seen[] = []
let reply: (s: Seen) => Response | Promise<Response> = () => Response.json({})
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    const text = (req.headers.get("content-type") ?? "").startsWith("multipart/") ? "" : await req.text()
    const s: Seen = { method: req.method, path: new URL(req.url).pathname, headers, body: undefined, text }
    try { s.body = text ? JSON.parse(text) : undefined } catch {}
    if (headers["content-type"]?.startsWith("multipart/")) s.body = Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === "string" ? v : `blob:${(v as Blob).size}`]))
    seen.push(s)
    return reply(s)
  },
})
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`
ops.endpoints.allowHost = () => true
ops.endpoints.graphql.production = `${base}/graphql`
ops.endpoints.graphql.sandbox = `${base}/sandbox/graphql`

let userCalls: boolean[] = [], appCalls: string[][] = []
const callCtx = (): ops.CallContext => ({
  marketplace: "EBAY_AU", sandbox: false, contentLanguage: "en-AU", granted: [],
  tokens: { user: async (force) => { userCalls.push(!!force); return force ? "fresh" : "stale" }, app: async (s) => { appCalls.push(s); return "app-tok" } },
})
beforeEach(() => { seen.length = 0; userCalls = []; appCalls = []; reply = () => Response.json({}) })

describe("callRest", () => {
  test("user ops send the user token as Bearer; app ops mint an app token for their scopes; Post-Order uses IAF", async () => {
    await ops.callRest(restOp({ method: "GET", body: undefined, server: base, path: "/u", params: [] }), { params: {} }, callCtx())
    await ops.callRest(restOp({ method: "GET", body: undefined, server: base, path: "/a", params: [], auth: "app", scopes: ["s1"] }), { params: {} }, callCtx())
    await ops.callRest(restOp({ method: "GET", body: undefined, server: base, path: "/p", params: [], scheme: "IAF" }), { params: {} }, callCtx())
    expect(seen.map((s) => s.headers.authorization)).toEqual(["Bearer stale", "Bearer app-tok", "IAF stale"])
    expect(appCalls).toEqual([["s1"]])
    expect(seen[0].headers["x-ebay-c-marketplace-id"]).toBe("EBAY_AU")
  })

  test("JSON bodies carry exactly one Content-Type", async () => {
    await ops.callRest(restOp({ server: base }), { params: { sku: "1" }, body: { a: 1 } }, callCtx())
    expect(seen[0].headers["content-type"]).toBe("application/json")
    expect(seen[0].body).toEqual({ a: 1 })
  })

  test("multipart uploads reach the server with their boundary and file", async () => {
    const m = restOp({ method: "POST", server: base, path: "/image", params: [{ name: "Content-Type", in: "header", required: true, type: "string", description: "" }], body: { contentTypes: ["multipart/form-data"], required: true } })
    reply = () => Response.json({ imageUrl: "https://i.ebayimg.com/x.jpg" })
    const r: any = await ops.callRest(m, { params: { "Content-Type": "multipart/form-data" }, files: { image: import.meta.path } }, callCtx())
    expect(seen[0].headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/)
    expect(seen[0].body.image).toBe(`blob:${Bun.file(import.meta.path).size}`)
    expect(r.imageUrl).toBe("https://i.ebayimg.com/x.jpg")
  })

  test("a 401 refreshes the user token once and retries", async () => {
    reply = (s) => (s.headers.authorization === "Bearer stale" ? new Response("expired", { status: 401 }) : Response.json({ ok: 1 }))
    expect(await ops.callRest(restOp({ method: "GET", body: undefined, server: base, path: "/u", params: [] }), { params: {} }, callCtx())).toEqual({ ok: 1 })
    expect(userCalls).toEqual([false, true])
  })

  test("an empty 201 answers with its status and Location", async () => {
    reply = () => new Response(null, { status: 201, headers: { location: "https://apim.ebay.com/commerce/media/v1_beta/image/abc" } })
    expect(await ops.callRest(restOp({ method: "POST", server: base, path: "/v", params: [], body: undefined }), { params: {} }, callCtx())).toEqual({ status: 201, location: "https://apim.ebay.com/commerce/media/v1_beta/image/abc" })
  })

  test("binary responses are saved with --output, and refused without it", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 0, 255])
    reply = () => new Response(pdf, { headers: { "content-type": "application/pdf" } })
    const op = restOp({ method: "GET", body: undefined, server: base, path: "/label", params: [] })
    await expect(ops.callRest(op, { params: {} }, callCtx())).rejects.toThrow(/6 bytes of application\/pdf; rerun with --output/)
    const file = join(mkdtempSync(join(tmpdir(), "social-ebay-out-")), "label.pdf")
    expect(await ops.callRest(op, { params: {} }, callCtx(), { output: file })).toEqual({ status: 200, contentType: "application/pdf", bytes: 6, path: file })
    expect([...readFileSync(file)]).toEqual([...pdf])
  })

  test("refuses to send a token to a non-eBay host by default", async () => {
    ops.endpoints.allowHost = ops.isEbayHost
    try { await expect(ops.callRest(restOp({ method: "GET", body: undefined, server: "https://evil.example", path: "/x", params: [] }), { params: {} }, callCtx())).rejects.toThrow(/refusing to send credentials to evil.example/) }
    finally { ops.endpoints.allowHost = () => true }
    expect(ops.isEbayHost("api.ebay.com")).toBe(true)
    expect(ops.isEbayHost("ebay.com.evil.example")).toBe(false)
  })
})

// ---------- GraphQL ----------

const SDL = `directive @authorize(scopes: [String!]!) on OBJECT | FIELD_DEFINITION
  type Query {
    search: Result
    listing(id: ID!): Listing
    orders: Orders
  }
  type Mutation { end(input: EndInput!): Boolean }
  input EndInput { listingId: ID! reason: Reason! note: String }
  enum Reason { SOLD LOST }
  union Result = Hits | Invalid
  type Hits { items: [Item] total: Int name: String }
  type Invalid { message: String name: String! }
  type Item { id: ID price(currency: String!): Float seller: Seller notes: String @authorize(scopes: ["https://api.ebay.com/oauth/api_scope/commerce.usernote"]) }
  type Seller { name: String }
  interface Listing { id: ID! questions: Int }
  type Single implements Listing { id: ID! questions: Int @authorize(scopes: ["https://api.ebay.com/oauth/api_scope/sell.listing.read"]) title: String }
  type Multi implements Listing { id: ID! questions: Int variations: Int }
  type Orders { seller(input: String!): [String] buyer(input: String!): [String] }`
const schema = buildSchema(SDL)
const gqlIndex: OpsIndex = { apis: { gql: { title: "t", version: "", spec: "x" } }, ops: gqlOps(SDL) }

describe("GraphQL", () => {
  beforeEach(() => ops.useForTests({ index: gqlIndex, schema }))

  test("default selections: union members don't spend depth, arg-taking fields are skipped, same-named fields of different shapes are aliased", () => {
    const sel = ops.selection(schema, schema.getQueryType()!.getFields().search.type, 1)
    expect(sel).toBe("{ __typename ... on Hits { items { id notes } total name } ... on Invalid { message name_Invalid: name } }")
    expect(ops.selection(schema, schema.getQueryType()!.getFields().search.type, 2)).toContain("items { id seller { name } notes }")
    expect(validate(schema, parse(`{ search ${sel} }`))).toEqual([])
  })

  test("fields the token can't read are left out, including interface fields restricted by an implementation", () => {
    const granted = new Set(["https://api.ebay.com/oauth/api_scope/sell.listing"])
    expect(ops.selection(schema, schema.getQueryType()!.getFields().search.type, 1, granted)).not.toContain("notes")
    const l = ops.selection(schema, schema.getQueryType()!.getFields().listing.type, 1, granted)
    // Single restricts questions (so the shared interface field goes), Multi doesn't (so its own copy stays).
    expect(l).toBe("{ __typename id ... on Single { title } ... on Multi { questions variations } }")
    expect(ops.selection(schema, schema.getQueryType()!.getFields().listing.type, 1, new Set(["https://api.ebay.com/oauth/api_scope/sell.listing.read"]))).toContain("questions")
  })

  test("buildGql: typed variables, --select with or without braces, argument and variable errors caught locally", async () => {
    const end = await ops.find("gql.end")
    const b = await ops.buildGql(end as ops.GqlOp, { input: { listingId: "1", reason: "SOLD" } })
    expect(b.query).toBe("mutation End($input: EndInput!) { end(input: $input) }")
    expect(b.variables).toEqual({ input: { listingId: "1", reason: "SOLD" } })
    await expect(ops.buildGql(end as ops.GqlOp, { input: { listingId: "1" } })).rejects.toThrow(/Field "reason" of required type "Reason!" was not provided/)
    await expect(ops.buildGql(end as ops.GqlOp, { nope: 1 })).rejects.toThrow(/no argument "nope"/)
    await expect(ops.buildGql(end as ops.GqlOp, {})).rejects.toThrow(/needs input: EndInput!/)
    const search = await ops.find("search") as ops.GqlOp
    expect((await ops.buildGql(search, {}, { select: "__typename" })).query).toBe("query Search { search { __typename } }")
    expect((await ops.buildGql(search, {}, { select: "{ __typename }" })).query).toBe("query Search { search { __typename } }")
    await expect(ops.buildGql(search, {}, { select: "bogus" })).rejects.toThrow(/Cannot query field "bogus"/)
  })

  test("a root whose children all need arguments explains --select instead of sending an invalid query", async () => {
    await expect(ops.buildGql(await ops.find("orders") as ops.GqlOp, {})).rejects.toThrow(/--select 'seller\(input: \{…\}\) \{ … \}'.*buyer\(input: String!\)/)
  })

  test("callGql: posts query, variables and operationName; partial errors are returned with a non-zero exit and their paths", async () => {
    reply = () => Response.json({ data: { search: { __typename: "Hits" } }, errors: [{ message: "unauthorized", path: ["search", "items", 0, "notes"] }] })
    const r: any = await ops.callGql("query S { search { __typename } }", {}, callCtx())
    expect(seen[0].path).toBe("/graphql")
    expect(seen[0].body).toEqual({ query: "query S { search { __typename } }", variables: {}, operationName: "S" })
    expect(r.data.search.__typename).toBe("Hits")
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  test("callGql: errors with no data throw with their paths; sandbox goes to the sandbox endpoint", async () => {
    reply = () => Response.json({ data: null, errors: [{ message: "Insufficient permissions", path: ["search"] }] })
    await expect(ops.callGql("{ search { __typename } }", {}, callCtx())).rejects.toThrow(/Insufficient permissions \(at search\)/)
    reply = () => Response.json({ data: { search: null } })
    await ops.callGql("{ search { __typename } }", {}, { ...callCtx(), sandbox: true })
    expect(seen.at(-1)!.path).toBe("/sandbox/graphql")
  })

  test("callGql validates variables and picks an operation by name", async () => {
    await expect(ops.callGql("mutation M($i: EndInput!) { end(input: $i) }", { i: { listingId: 1 } }, callCtx())).rejects.toThrow(/invalid arguments/)
    await expect(ops.callGql("query A { search { __typename } } query B { search { __typename } }", {}, callCtx())).rejects.toThrow(/pass --operation/)
    reply = () => Response.json({ data: { search: null } })
    await ops.callGql("query A { search { __typename } } query B { search { __typename } }", {}, callCtx(), "B")
    expect(seen.at(-1)!.body.operationName).toBe("B")
  })

  test("describe lists required input paths and drills into one input", async () => {
    const d = await ops.describe(await ops.find("gql.end"))
    expect(d).toContain("required fields:\n  input.listingId\n  input.reason")
    expect(await ops.describe(await ops.find("gql.end"), { path: "input.reason" })).toContain("one of: SOLD, LOST")
    await expect(ops.describe(await ops.find("gql.end"), { path: "input.nope" })).rejects.toThrow(/no field "nope" on EndInput; fields: listingId, reason, note/)
  })
})

describe("find and search", () => {
  const idx: OpsIndex = { apis: { a: { title: "", version: "", spec: "" }, b: { title: "", version: "", spec: "" }, gql: { title: "", version: "", spec: "" } }, ops: [
    restOp({ id: "a.getThing", api: "a", operationId: "getThing", summary: "Gets a thing.", keywords: "" }),
    restOp({ id: "b.getThing", api: "b", operationId: "getThing", summary: "Gets another thing.", keywords: "" }),
    restOp({ id: "b.updateStock", api: "b", operationId: "updateStock", summary: "Changes stock.", keywords: "fixedprice pricingterms" }),
    restOp({ id: "a.priceReport", api: "a", operationId: "priceReport", summary: "A report.", keywords: "" }),
  ] }
  beforeEach(() => ops.useForTests({ index: idx }))

  test("exact ids win, bare ids resolve when unique, ambiguity and near misses are explained", async () => {
    expect((await ops.find("A.GETTHING")).id).toBe("a.getThing")
    expect((await ops.find("updatestock")).id).toBe("b.updateStock")
    await expect(ops.find("getThing")).rejects.toThrow(/ambiguous: a.getThing, b.getThing/)
    await expect(ops.find("thing")).rejects.toThrow(/did you mean a.getThing, b.getThing/)
  })

  test("every word must match; id matches rank above keyword matches; unknown APIs are named", async () => {
    expect((await ops.search("price")).map((o) => o.id)).toEqual(["a.priceReport", "b.updateStock"])
    expect((await ops.search("thing", "b")).map((o) => o.id)).toEqual(["b.getThing"])
    expect(await ops.search("thing zebra")).toEqual([])
    await expect(ops.search("x", "nope")).rejects.toThrow(/unknown API "nope"; one of: a, b, gql/)
  })
})

// Against the real pulled schema, when present (CI pulls it in verify-gen before tests).
const real = join(import.meta.dir, "..", "specs", "ebay-graphql.graphqls")
test.skipIf(!existsSync(real))("every eBay GraphQL root field's default selection validates at depths 1-4", () => {
  const s = buildSchema(readFileSync(real, "utf8"))
  const bad: string[] = []
  for (const root of [s.getQueryType()!, s.getMutationType()!]) for (const f of Object.values(root.getFields())) for (const d of [1, 2, 3, 4]) {
    const sel = ops.selection(s, f.type, d)
    if (!sel) continue
    const vars = f.args.map((a) => `$${a.name}: ${a.type}`).join(", ")
    const q = `${root === s.getQueryType() ? "query" : "mutation"} X${vars ? `(${vars})` : ""} { ${f.name}${f.args.length ? `(${f.args.map((a) => `${a.name}: $${a.name}`).join(", ")})` : ""} ${sel} }`
    const errs = validate(s, parse(q))
    if (errs.length) bad.push(`${f.name}@${d}: ${errs[0].message}`)
  }
  expect(bad).toEqual([])
})
