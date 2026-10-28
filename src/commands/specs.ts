/**
 * `social specs pull [name]` — fetch the API descriptions the CLI is generated from and
 * regenerate, so nothing generated has to live in git. Drift from a pin is reported but
 * accepted, and pins are never written here; `bun run verify-gen` is the strict check,
 * `bun run gen` pins new specs, `--update` (here or there) re-pins changed ones.
 */
import { Command } from "commander"
import { pullSpecs, selectSpecs, specPath } from "../core/specs.ts"
import { existsSync, statSync } from "node:fs"
import { emit } from "../core/output.ts"

export function specsCommand(): Command {
  const c = new Command("specs").description("pull and regenerate the API specs the CLI is built from (not committed to git)")
  c.command("pull [name]").description("fetch specs (all, a platform family like `ebay`, or one spec) and regenerate code")
    .option("--update", "re-pin specs whose upstream changed (writes spec-pins.json)")
    .action(async (name: string | undefined, o) => {
      if (!(await pullSpecs({ only: name, update: o.update, lenient: !o.update, log: (m) => process.stderr.write(m + "\n") }))) process.exitCode = 1
    })
  c.command("list [name]").description("which specs exist locally and when they were pulled").option("--json").action(async (name: string | undefined, o) => {
    const rows = selectSpecs(name).map((s) => { const f = specPath(s); return { name: s.name, url: s.url, pulled: existsSync(f) ? statSync(f).mtime.toISOString() : null } })
    await emit(rows, o, (d) => d.map((r: any) => `${r.pulled ? "✓" : "·"} ${r.name.padEnd(46)} ${r.pulled ?? "not pulled"}`).join("\n"))
  })
  return c
}
