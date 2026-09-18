import { Command } from "commander"
import type { Platform } from "../core/platform.ts"
import * as config from "../core/config.ts"
import { emit } from "../core/output.ts"

export function authCommand(platforms: Record<string, Platform>): Command {
  const c = new Command("auth").description("Store credentials for a platform (keyring, or ~/.config/social/.env)")
  c.command("set <platform> <key> <value>").description("store one credential value").action(async (platform, key, value) => {
    const p = platforms[platform]; if (!p) throw new Error(`unknown platform ${platform}`)
    if (!p.credentials.keys.includes(key)) throw new Error(`${platform} does not use ${key}; expected one of ${p.credentials.keys.join(", ")}`)
    const where = await config.set(key, value)
    process.stderr.write(`stored ${key} in ${where === "keyring" ? "the OS keyring" : config.ENV_FILE}\n`)
  })
  c.command("login <platform>").description("run the platform's interactive auth flow, where one exists").action(async (platform) => {
    const p = platforms[platform]; if (!p) throw new Error(`unknown platform ${platform}`)
    if (!p.auth) throw new Error(`${platform} has no interactive flow; use \`social auth set ${platform} <KEY> <value>\` for: ${p.credentials.keys.join(", ")}\n${p.credentials.hint}`)
    await p.auth()
  })
  c.command("status [platform]").description("which credentials are present, and where").action(async (platform?: string) => {
    const list = platform ? [platforms[platform]] : Object.values(platforms)
    const rows: Record<string, unknown>[] = []
    for (const p of list) {
      if (!p) throw new Error(`unknown platform ${platform}`)
      for (const k of p.credentials.keys) rows.push({ platform: p.name, key: k, present: !!(await config.get(k)) })
    }
    await emit(rows, {}, (r) => r.map((x: any) => `${x.present ? "✓" : "✗"} ${x.platform.padEnd(10)} ${x.key}`).join("\n"))
  })
  return c
}

export function doctorCommand(platforms: Record<string, Platform>): Command {
  return new Command("doctor").description("make one cheap authenticated call per configured platform and report").option("--json").action(async (o) => {
    const out: Record<string, unknown>[] = []
    for (const p of Object.values(platforms)) {
      const have = (await Promise.all(p.credentials.keys.map((k) => config.get(k)))).every(Boolean)
      if (!have) { out.push({ platform: p.name, status: "not configured" }); continue }
      if (!p.whoami) { out.push({ platform: p.name, status: "configured (no check available)" }); continue }
      try { const who = await p.whoami(); out.push({ platform: p.name, status: "ok", who }) }
      catch (e: any) { out.push({ platform: p.name, status: "error", error: e.message.split("\n")[0] }) }
    }
    await emit(out, o, (r) => r.map((x: any) => `${x.status === "ok" ? "✓" : x.status === "error" ? "✗" : "·"} ${x.platform.padEnd(10)} ${x.status}${x.who ? "  " + JSON.stringify(x.who) : ""}${x.error ? "  " + x.error : ""}`).join("\n"))
  })
}
