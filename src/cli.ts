#!/usr/bin/env bun
import { Command } from "commander"
import { dryRun } from "./core/http.ts"
import { apiCommand } from "./commands/api.ts"
import { authCommand, doctorCommand } from "./commands/auth.ts"
import { PLATFORMS } from "./platforms/index.ts"

const program = new Command("social")
  .description("One CLI for social, video, marketplace and email APIs, built from each platform's live spec. Runs on Bun; no build step.")
  .version("2.0.0")
  .option("--dry-run", "print what would be sent instead of sending it (mutating calls only)")
  .hook("preAction", (cmd) => { if (cmd.optsWithGlobals().dryRun) dryRun.enabled = true })

for (const p of Object.values(PLATFORMS)) {
  const sub = new Command(p.name).description(p.summary)
  p.register(sub)
  program.addCommand(sub)
}
program.addCommand(apiCommand(PLATFORMS))
program.addCommand(authCommand(PLATFORMS))
program.addCommand(doctorCommand(PLATFORMS))

try {
  await program.parseAsync(process.argv)
} catch (e: any) {
  const msg = e?.message ?? String(e)
  process.stderr.write(`social: ${msg}\n`)
  process.exit(1)
}
