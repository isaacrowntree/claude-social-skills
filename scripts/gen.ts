#!/usr/bin/env bun
/**
 * `bun run gen` pulls every spec, pins new ones and regenerates; `--verify` (CI) fails on any
 * spec that differs from its pin; `--update` re-pins; `--only=<name|family>` narrows it.
 * The logic lives in src/core/specs.ts so `social specs pull` shares it.
 */
import { pullSpecs } from "../src/core/specs.ts"

const verify = process.argv.includes("--verify")
const ok = await pullSpecs({
  verify,
  update: process.argv.includes("--update"),
  only: process.argv.find((a) => a.startsWith("--only="))?.slice(7),
  log: (m, error) => (error ? process.stderr : process.stdout).write(m + "\n"),
})
if (!ok) process.exit(1)
if (verify) process.stdout.write("verify-gen: all specs match their pins\n")
