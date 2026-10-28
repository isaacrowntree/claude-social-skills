/**
 * The spec registry and the code that pulls it. Each entry is one machine-readable API
 * description; its SHA-256 pin lives in spec-pins.json at the repo root. Specs and
 * everything generated from them are NOT committed: `social specs pull` (or `bun run gen`)
 * recreates them, `bun run verify-gen` fails when upstream differs from a pin, and
 * `bun run gen --update` re-pins. Same policy as clickup-cli.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = fileURLToPath(new URL("../..", import.meta.url))
export const SPEC_DIR = join(ROOT, "specs")
export const PINS_FILE = join(ROOT, "spec-pins.json")

export interface SpecSource {
  name: string
  url: string
  /** File extension under specs/ (default "json"). */
  ext?: string
  /** Normalise the upstream text before generation (like clickup's patch-v2-spec.jq). Keep it tiny and documented. */
  patch?: (text: string) => string
  /** Generate types from the normalised spec. */
  generate?: (specPath: string, root: string) => Promise<void>
}

async function openapiTypes(specPath: string, root: string, platform: string) {
  const outDir = join(root, "src", "platforms", platform)
  const p = Bun.spawn(["bunx", "openapi-typescript", specPath, "-o", join(outDir, "types.gen.ts")], { stdout: "inherit", stderr: "inherit" })
  if ((await p.exited) !== 0) throw new Error(`openapi-typescript failed for ${platform}`)
}

/**
 * eBay publishes one OpenAPI 3 document per REST API at developer.ebay.com/develop/api/spec/<name>.json,
 * and ONE GraphQL schema covering every modernized API (Listing, offers, orders, returns, inquiries…)
 * at …/spec/<any graphql api name>.graphqls. Left out: deal_api and offer_api (Buy scopes this app is
 * not granted), client_registration_api (tppz host, third-party providers only),
 * marketplace_insights_api (served as YAML, restricted).
 */
export const EBAY_REST = [
  "account_api_v1", "account_api_v2", "analytics_api", "browse_api", "catalog_api", "charity_api",
  "developer_analytics_api", "edelivery_international_shipping_api", "feed_api", "feedback_api",
  "finances_api", "fulfillment_api", "identity_api", "inventory_api", "key_management_api", "leads_api",
  "logistics_api", "marketing_api", "media_api", "message_api", "metadata_api", "negotiation_api",
  "notification_api", "post_order_api", "recommendation_api", "stores_api", "taxonomy_api",
  "translation_api", "vero_api_v2",
]

/** Steps that run once a family's specs ("ebay" = every "ebay-*" spec) are all fetched. */
export interface PostGen { name: string; run: (specDir: string) => Promise<void> }
/** Platforms with one spec each get a generated operation index (src/platforms/<name>/ops.gen.json). */
const SINGLE_SPEC: { name: string; scheme?: string }[] = [
  { name: "x" }, { name: "mastodon" }, { name: "bluesky" }, { name: "youtube" },
  { name: "pinterest" }, { name: "discord", scheme: "Bot" }, { name: "etsy" },
]
export const POST_GEN: PostGen[] = [
  { name: "ebay", run: async (dir) => { await (await import("../platforms/ebay/build-index.ts")).buildEbayOps(dir) } },
  ...SINGLE_SPEC.map(({ name, scheme }): PostGen => ({
    name, run: async (dir) => { (await import("./openapi.ts")).buildIndex({ spec: name, specDir: dir, scheme, out: join(ROOT, "src", "platforms", name, "ops.gen.json") }) },
  })),
]

export const SPECS: SpecSource[] = [
  {
    name: "x",
    url: "https://api.x.com/2/openapi.json",
    generate: (p, r) => openapiTypes(p, r, "x"),
  },
  {
    name: "mastodon",
    url: "https://raw.githubusercontent.com/abraham/mastodon-openapi/main/dist/schema.json",
    generate: (p, r) => openapiTypes(p, r, "mastodon"),
  },
  {
    name: "bluesky",
    // Bluesky's own OpenAPI 3.1 rendering of the app.bsky + com.atproto lexicons (152 paths).
    // The typed client @atproto/api is generated upstream from the same lexicons, so no generate step.
    url: "https://endpoints.bsky.app/openapi.bluesky-app.json",
  },
  {
    name: "youtube",
    url: "https://youtube.googleapis.com/$discovery/rest?version=v3",
    // Google Discovery is not OpenAPI; the `googleapis` package is generated from it upstream,
    // so here we only pin the document and record its revision for the skill docs.
  },
  // Pinterest publishes its v5 OpenAPI on GitHub; JSON and YAML renderings are identical.
  { name: "pinterest", url: "https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.json" },
  // Discord's official HTTP API description (v10).
  { name: "discord", url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json" },
  { name: "etsy", url: "https://www.etsy.com/openapi/generated/oas/3.0.0.json" },
  ...EBAY_REST.map((api): SpecSource => ({ name: `ebay-${api}`, url: `https://developer.ebay.com/develop/api/spec/${api}.json` })),
  { name: "ebay-graphql", url: "https://developer.ebay.com/develop/api/spec/listing.graphqls", ext: "graphqls" },
]

/**
 * X and Google serve a different byte stream on every fetch (key order, an etag,
 * a revision stamp) while the API described is unchanged, so the pin is over a
 * canonical form: parsed JSON with keys sorted and volatile top-level fields removed.
 */
export function canonical(text: string): string {
  try {
    const v = JSON.parse(text)
    for (const k of ["etag", "revision", "x-generated-at"]) delete v[k]
    // Arrays of plain strings are treated as sets: X emits OAuth scope lists in a random order per response.
    const sort = (x: any): any => Array.isArray(x)
      ? (x.every((e) => typeof e === "string") ? [...x].sort() : x.map(sort))
      : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x
    return JSON.stringify(sort(v))
  } catch { return text }
}

/** Write via a temp file and rename, so a concurrent reader never sees half a file. */
export function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

export function specPath(s: Pick<SpecSource, "name" | "ext">, specDir = SPEC_DIR): string { return join(specDir, `${s.name}.${s.ext ?? "json"}`) }

/** `only` matches a spec name exactly or a family prefix: "ebay" selects every "ebay-*" spec. */
export function selectSpecs(only?: string, specs = SPECS): SpecSource[] {
  return specs.filter((s) => !only || s.name === only || s.name.startsWith(only + "-"))
}

export interface PullOptions {
  only?: string
  /** Fail on any spec whose hash differs from its pin, or that has no pin (CI). Never writes pins. */
  verify?: boolean
  /** Re-pin specs whose upstream changed. */
  update?: boolean
  /** Accept unpinned or drifted specs with a note, and never write pins (`social specs pull`, first use). */
  lenient?: boolean
  /** `error` is true for failures, so a CLI can send them to stderr. */
  log?: (msg: string, error?: boolean) => void
  /** Overrides for tests. */
  specs?: SpecSource[]; postGen?: PostGen[]; specDir?: string; pinsFile?: string; root?: string
  fetch?: typeof fetch
}

const CONCURRENCY = 6
const TIMEOUT_MS = 60_000

async function fetchSpec(s: SpecSource, f: typeof fetch): Promise<{ text?: string; error?: string }> {
  let last = ""
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await f(s.url, { headers: { "user-agent": "social-cli gen (+https://github.com/isaacrowntree/claude-social-skills)" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return { text: await res.text() }
      last = `HTTP ${res.status}`
      if (res.status !== 429 && res.status < 500) break
    } catch (e: any) { last = e?.message ?? String(e) }
    if (attempt === 1) await Bun.sleep(1000)
  }
  return { error: last }
}

/** Fetch, check, write and generate. Resolves false if any selected spec failed; never throws for one bad spec. */
export async function pullSpecs(o: PullOptions = {}): Promise<boolean> {
  const log = o.log ?? ((m: string) => process.stderr.write(m + "\n"))
  const specDir = o.specDir ?? SPEC_DIR, pinsFile = o.pinsFile ?? PINS_FILE, root = o.root ?? ROOT
  const pins: Record<string, string> = existsSync(pinsFile) ? JSON.parse(readFileSync(pinsFile, "utf8")) : {}
  let pinsChanged = false
  const failed = new Set<string>()
  mkdirSync(specDir, { recursive: true })
  const specs = selectSpecs(o.only, o.specs)
  if (!specs.length) throw new Error(`no spec matches "${o.only}"`)

  const results: { text?: string; error?: string }[] = new Array(specs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, specs.length) }, async () => {
    while (next < specs.length) { const i = next++; results[i] = await fetchSpec(specs[i], o.fetch ?? fetch) }
  }))

  for (const [i, s] of specs.entries()) {
    const { text, error } = results[i]
    if (text === undefined) { log(`${s.name}: ${error} from ${s.url}`, true); failed.add(s.name); continue }
    const sha = createHash("sha256").update(canonical(text)).digest("hex")
    const pin = pins[s.name]
    if (!pin) {
      if (o.verify) { log(`${s.name}: unpinned (sha256 ${sha}); run \`bun run gen\` and commit spec-pins.json`, true); failed.add(s.name); continue }
      if (o.lenient) log(`${s.name}: no pin yet; using it (\`bun run gen\` pins it)`)
      else { pins[s.name] = sha; pinsChanged = true; log(`${s.name}: pinned ${sha.slice(0, 12)}`) }
    } else if (pin !== sha) {
      if (o.update) { pins[s.name] = sha; pinsChanged = true; log(`${s.name}: re-pinned ${pin.slice(0, 12)} → ${sha.slice(0, 12)}`) }
      else if (o.lenient) log(`${s.name}: upstream changed since the pin (${pin.slice(0, 12)} → ${sha.slice(0, 12)}); using it anyway`)
      else { log(`${s.name}: sha256 mismatch: upstream published a new spec.\n  pinned ${pin}\n  got    ${sha}\n  Run \`bun run gen --update\` to review and re-pin.`, true); failed.add(s.name); continue }
    }
    if (!s.ext || s.ext === "json") writeAtomic(join(specDir, `${s.name}.raw`), text)
    writeAtomic(specPath(s, specDir), s.patch ? s.patch(text) : text)
    if (s.generate) await s.generate(specPath(s, specDir), root)
  }
  if (pinsChanged && !o.verify && !o.lenient) writeAtomic(pinsFile, JSON.stringify(Object.fromEntries(Object.entries(pins).sort()), null, 2) + "\n")
  for (const g of o.postGen ?? POST_GEN) {
    const family = specs.filter((s) => s.name === g.name || s.name.startsWith(g.name + "-"))
    if (!family.length) continue
    const bad = family.filter((s) => failed.has(s.name))
    // A partial family would generate an index that silently lacks those APIs; keep the last good one instead.
    if (bad.length) { log(`${g.name}: not regenerated; ${bad.length} spec(s) failed (${bad.map((s) => s.name).join(", ")})`, true); continue }
    await g.run(specDir)
    log(`${g.name}: generated`)
  }
  return failed.size === 0
}
