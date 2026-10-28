#!/usr/bin/env bun
/**
 * Generate one SKILL.md per platform from the CLI itself, so the docs Claude
 * reads are exactly the commands and flags the binary accepts. `--verify`
 * fails when a checked-in SKILL.md differs from what the code would produce,
 * which is the CI guard against drift (clickup-cli's `make check` idea).
 */
import { Command } from "commander"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLATFORMS } from "../src/platforms/index.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const verify = process.argv.includes("--verify")

function flagLine(o: any): string {
  const req = o.mandatory ? " (required)" : ""
  const def = o.defaultValue !== undefined ? ` (default ${JSON.stringify(o.defaultValue)})` : ""
  return `  ${o.flags.padEnd(26)} ${o.description}${req}${def}`
}

function usage(c: Command, prefix: string): string {
  const args = c.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`) + (a.variadic ? "..." : "")).join(" ")
  const opts = c.options.filter((o) => !["--json", "--jq <e>"].includes(o.flags)).map(flagLine)
  return `### \`${prefix} ${c.name()}${args ? " " + args : ""}\`\n\n${c.description()}\n${opts.length ? "\n```\n" + opts.join("\n") + "\n```\n" : ""}`
}

let drift = false
for (const p of Object.values(PLATFORMS)) {
  const cmd = new Command(p.name); p.register(cmd)
  const sections = cmd.commands.map((c) => usage(c, `social ${p.name}`)).join("\n")
  const extra = p.skill ? await p.skill() : undefined
  const creds = p.credentials.keys.length ? p.credentials.keys.map((k) => `- \`${k}\``).join("\n") : "- none; auth lives in the underlying tool's own config"
  const md = `---
name: social-${p.name}
description: ${extra?.description ?? `${p.summary}. Use the \`social\` CLI (Bun) for every ${p.name} action; every endpoint is reachable through \`social api ${p.name} <path>\`, so prefer this CLI over raw API calls in all cases.`}
---

# social ${p.name}

${p.summary}.

**Run:** \`social ${p.name} <command>\` (installed via \`bun link\` in this repo, or \`bun run /path/to/claude-social-skills/src/cli.ts ${p.name} …\`). Add \`--dry-run\` before any command to print the request instead of sending it.

## Credentials

${creds}

${p.credentials.hint}

Check what is present with \`social auth status ${p.name}\`; store a value with \`social auth set ${p.name} <KEY> <value>\` (OS keyring, else \`~/.config/social/.env\`)${p.auth ? `; run the interactive flow with \`social auth login ${p.name}\`` : ""}. Docs: ${p.credentials.docsUrl}

## API description this wrapper is built from

${p.spec.kind === "none" ? `No machine-readable spec: ${p.spec.source}.` : `${p.spec.kind}: ${p.spec.source}. Refresh with \`social specs pull ${p.name}\`; CI fails if upstream changes.`}

## Commands

Every command accepts \`--json\` (raw JSON) and \`--jq <expr>\` (filter the JSON with jq).

${sections}
${extra?.escapeHatch ?? `## Anything else: the escape hatch

\`\`\`bash
social api ${p.name} <path>                       # GET, path relative to the API root
social api ${p.name} <path> -q key=value          # query parameters
social api ${p.name} <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api ${p.name} <path> --raw-field key=value # string field
social api ${p.name} <path> -X DELETE
social api ${p.name} <path> --input body.json     # or --input - for stdin
social api ${p.name} <path> --form                # urlencoded body instead of JSON
social api ${p.name} <path> --jq '.data[0].id'
\`\`\`

Reach for \`social api ${p.name} …\` before concluding something is unsupported.
`}${extra ? "\n" + extra.body.trim() + "\n" : ""}
## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print \`HTTP <status> <method> <url>\` and the response body, exit code 1.
- \`--dry-run\` prints the method, URL and body of any mutating call and sends nothing.
- \`social doctor\` makes one cheap authenticated read per configured platform.
`
  const dir = join(ROOT, "skills", `social-${p.name}`); const file = join(dir, "SKILL.md")
  if (verify) {
    const cur = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (cur !== md) { console.error(`skills/social-${p.name}/SKILL.md is out of date; run \`bun run gen-skills\``); drift = true }
  } else { mkdirSync(dir, { recursive: true }); writeFileSync(file, md); process.stdout.write(`wrote ${file}\n`) }
}
if (verify && drift) process.exit(1)
if (verify) process.stdout.write("gen-skills --verify: all SKILL.md files match the CLI\n")
