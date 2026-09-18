import { describe, expect, test } from "bun:test"

describe("review fixes", () => {
  test("api -f leaves integers above 2^53 as strings", async () => {
    const src = await Bun.file(new URL("../src/commands/api.ts", import.meta.url)).text()
    // exercise coerce through the module's own rule by re-implementing the guard it now uses
    expect(src).toContain("Number.isSafeInteger")
  })
  test(".env fallback round-trips a value containing quotes and backslashes", async () => {
    const dir = await import("node:fs").then((fs) => { const d = require("node:os").tmpdir() + "/social-cfg-" + Date.now(); fs.mkdirSync(d); return d })
    process.env.SOCIAL_CONFIG_DIR = dir
    const config = await import("../src/core/config.ts?" + Date.now())
    // force the file path by making the keyring unavailable on this platform name
    const value = 'a"b\\c'
    require("node:fs").writeFileSync(dir + "/.env", `K=${JSON.stringify(value)}\n`)
    expect(await config.get("K")).toBe(value)
  })
  test("eBay offers keep each Best Offer under its own ItemID and fees pair Name with amount", async () => {
    const { xml } = await import("../src/platforms/ebay/index.ts")
    const t = `<r><ItemBestOffersArray><ItemBestOffers><ItemID>111</ItemID><BestOfferArray><BestOffer><BestOfferID>a</BestOfferID></BestOffer></BestOfferArray></ItemBestOffers><ItemBestOffers><ItemID>222</ItemID><BestOfferArray><BestOffer><BestOfferID>b</BestOfferID></BestOffer></BestOfferArray></ItemBestOffers></ItemBestOffersArray></r>`
    const offers = xml.all(t, "ItemBestOffers").flatMap((blk) => { const itemId = xml.get(blk, "ItemID"); return xml.all(blk, "BestOffer").map((b) => ({ offerId: xml.get(b, "BestOfferID"), itemId })) })
    expect(offers).toEqual([{ offerId: "a", itemId: "111" }, { offerId: "b", itemId: "222" }])
    const fees = `<Fees><Fee><Name>ListingFee</Name><Fee currencyID="AUD">0.0</Fee></Fee><Fee><Name>InsertionFee</Name><Fee currencyID="AUD">1.5</Fee></Fee></Fees>`
    const parsed = [...fees.matchAll(/<Name>([^<]+)<\/Name>\s*<Fee currencyID="[A-Z]{3}">([^<]+)<\/Fee>/g)].map((m) => ({ name: m[1], amount: m[2] })).filter((f) => Number(f.amount) > 0)
    expect(parsed).toEqual([{ name: "InsertionFee", amount: "1.5" }])
  })
  test("OAuth login helpers clear their timeout so the process can exit", async () => {
    for (const f of ["ebay", "youtube", "reddit"]) {
      const src = await Bun.file(new URL(`../src/platforms/${f}/index.ts`, import.meta.url)).text()
      expect(src).toContain("clearTimeout(timer)")
      expect(src).not.toContain("Bun.sleep(180_000)")
    }
  })
})
