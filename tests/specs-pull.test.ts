import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { canonical, pullSpecs, selectSpecs, type SpecSource } from "../src/core/specs.ts"

const sha = (t: string) => createHash("sha256").update(canonical(t)).digest("hex")
const SPECS: SpecSource[] = [{ name: "fam-a", url: "https://x/a" }, { name: "fam-b", url: "https://x/b" }, { name: "solo", url: "https://x/s" }]

/** A pull against a temp dir and a fake fetch; returns what it wrote and logged. */
async function pull(opts: { pins?: Record<string, string>; bodies?: Record<string, string | Error | number>; only?: string; verify?: boolean; update?: boolean; lenient?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "social-specs-"))
  const pinsFile = join(dir, "pins.json")
  if (opts.pins) writeFileSync(pinsFile, JSON.stringify(opts.pins))
  const bodies = { "https://x/a": '{"a":1}', "https://x/b": '{"b":1}', "https://x/s": '{"s":1}', ...opts.bodies }
  const logs: string[] = []
  const generated: string[] = []
  const fakeFetch = (async (url: string) => {
    const b = (bodies as any)[url]
    if (b instanceof Error) throw b
    return typeof b === "number" ? new Response("no", { status: b }) : new Response(b)
  }) as unknown as typeof fetch
  const ok = await pullSpecs({ ...opts, specs: SPECS, specDir: dir, pinsFile, root: dir, fetch: fakeFetch, log: (m) => logs.push(m), postGen: [{ name: "fam", run: async () => { generated.push("fam") } }] })
  return { ok, dir, logs, generated, pins: existsSync(pinsFile) ? JSON.parse(readFileSync(pinsFile, "utf8")) : undefined }
}

describe("pullSpecs", () => {
  test("`only` selects a spec or a family", () => {
    expect(selectSpecs("fam", SPECS).map((s) => s.name)).toEqual(["fam-a", "fam-b"])
    expect(selectSpecs("solo", SPECS).map((s) => s.name)).toEqual(["solo"])
  })

  test("a normal pull pins new specs, writes them, and runs the family generator", async () => {
    const r = await pull({})
    expect(r.ok).toBe(true)
    expect(r.pins).toEqual({ "fam-a": sha('{"a":1}'), "fam-b": sha('{"b":1}'), solo: sha('{"s":1}') })
    expect(readFileSync(join(r.dir, "fam-a.json"), "utf8")).toBe('{"a":1}')
    expect(r.generated).toEqual(["fam"])
  })

  test("lenient (social specs pull, first use) accepts unpinned and drifted specs but never writes pins", async () => {
    const r = await pull({ lenient: true, pins: { "fam-a": "old" } })
    expect(r.ok).toBe(true)
    expect(r.pins).toEqual({ "fam-a": "old" })
    expect(r.logs.join("\n")).toMatch(/fam-a: upstream changed since the pin.*using it anyway/)
  })

  test("verify fails on drift and on missing pins, and writes nothing to the pins file", async () => {
    const r = await pull({ verify: true, pins: { "fam-a": "old", "fam-b": sha('{"b":1}') } })
    expect(r.ok).toBe(false)
    expect(r.logs.join("\n")).toMatch(/fam-a: sha256 mismatch[\s\S]*solo: unpinned/)
    expect(r.pins).toEqual({ "fam-a": "old", "fam-b": sha('{"b":1}') })
  })

  test("update re-pins what changed", async () => {
    const r = await pull({ update: true, pins: { "fam-a": "old" } })
    expect(r.pins["fam-a"]).toBe(sha('{"a":1}'))
  })

  test("one failed spec (404, network error) doesn't stop the others, and keeps its family's previous index", async () => {
    const r = await pull({ bodies: { "https://x/a": 404, "https://x/s": new Error("getaddrinfo ENOTFOUND") } })
    expect(r.ok).toBe(false)
    expect(existsSync(join(r.dir, "fam-b.json"))).toBe(true)
    expect(r.generated).toEqual([])
    expect(r.logs.join("\n")).toMatch(/fam-a: HTTP 404[\s\S]*solo: getaddrinfo ENOTFOUND[\s\S]*fam: not regenerated; 1 spec\(s\) failed \(fam-a\)/)
  })

  test("a 5xx is retried once", async () => {
    let calls = 0
    const dir = mkdtempSync(join(tmpdir(), "social-specs-"))
    const ok = await pullSpecs({ only: "solo", specs: SPECS, specDir: dir, pinsFile: join(dir, "p.json"), root: dir, postGen: [], log: () => {},
      fetch: (async () => (++calls === 1 ? new Response("busy", { status: 503 }) : new Response("{}"))) as unknown as typeof fetch })
    expect([ok, calls]).toEqual([true, 2])
  })
})
