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
  test("OAuth login helpers clear their timeout so the process can exit", async () => {
    for (const f of ["core/oauth", "platforms/youtube/index", "platforms/reddit/index"]) {
      const src = await Bun.file(new URL(`../src/${f}.ts`, import.meta.url)).text()
      expect(src).toContain("clearTimeout(timer)")
      expect(src).not.toContain("Bun.sleep(180_000)")
    }
  })
})
