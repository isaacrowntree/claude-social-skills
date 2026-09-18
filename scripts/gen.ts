#!/usr/bin/env bun
/**
 * Pull each platform's live API description, pin it by SHA-256, and generate
 * TypeScript types from it. Specs and generated types are NOT committed:
 * `bun run gen` recreates them, and `bun run verify-gen` fails when upstream
 * has published something different from the pinned hash (then re-pin with
 * `bun run gen --update`). Same policy as clickup-cli.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SPECS } from "./specs.ts"

const ROOT = new URL("..", import.meta.url).pathname

/**
 * X and Google serve a different byte stream on every fetch (key order, an etag,
 * a revision stamp) while the API described is unchanged, so the pin is over a
 * canonical form: parsed JSON with keys sorted and volatile top-level fields removed.
 */
function canonical(text: string): string {
  try {
    const v = JSON.parse(text)
    for (const k of ["etag", "x-generated-at"]) delete v[k]
    // Arrays of plain strings are treated as sets: X emits OAuth scope lists in a random order per response.
    const sort = (x: any): any => Array.isArray(x)
      ? (x.every((e) => typeof e === "string") ? [...x].sort() : x.map(sort))
      : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x
    return JSON.stringify(sort(v))
  } catch { return text }
}
const SPEC_DIR = join(ROOT, "specs")
const verify = process.argv.includes("--verify")
const update = process.argv.includes("--update")
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7)

mkdirSync(SPEC_DIR, { recursive: true })
let failed = false
for (const s of SPECS) {
  if (only && s.name !== only) continue
  const raw = join(SPEC_DIR, `${s.name}.raw`)
  const out = join(SPEC_DIR, `${s.name}.json`)
  process.stdout.write(`${s.name}: fetching ${s.url}\n`)
  const res = await fetch(s.url, { headers: { "user-agent": "social-cli gen (+https://github.com/isaacrowntree/claude-social-skills)" } })
  if (!res.ok) { console.error(`  ${res.status} from upstream`); failed = true; continue }
  const text = await res.text()
  const sha = createHash("sha256").update(canonical(text)).digest("hex")
  if (s.sha256 && sha !== s.sha256) {
    if (update) { process.stdout.write(`  new sha256 ${sha} (was ${s.sha256}); update scripts/specs.ts\n`) }
    else { console.error(`  sha256 mismatch: upstream published a new spec.\n  pinned ${s.sha256}\n  got    ${sha}\n  Run \`bun run gen --update\` to review and re-pin.`); failed = true; continue }
  } else if (!s.sha256) process.stdout.write(`  unpinned; sha256 ${sha}\n`)
  writeFileSync(raw, text)
  const patched = s.patch ? s.patch(text) : text
  writeFileSync(out, patched)
  if (s.generate) await s.generate(out, ROOT)
}
if (failed) process.exit(1)
if (verify) process.stdout.write("verify-gen: all specs match their pins\n")
