/**
 * Where `social` keeps its state, and how it reads secrets.
 *
 * Secrets come from three places, in this order, and the first hit wins:
 *   1. the process environment (so CI and Doppler `dr social …` just work)
 *   2. `$SOCIAL_CONFIG_DIR/.env` (default `~/.config/social/.env`), a KEY=value file
 *   3. the OS keyring via `security` on macOS / `secret-tool` on Linux, keyed `social/<KEY>`
 * `social auth <platform>` writes to the keyring when it can and falls back to the
 * .env file with a warning, the same policy as clickup-cli / slackbuzz-cli.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs"

// Read per call, not at import: SOCIAL_CONFIG_DIR may change after this module loads (each test file
// sets its own while bun runs them all in one process; CI's file order exposed the import-time version).
export function configDir(): string { return process.env.SOCIAL_CONFIG_DIR ?? join(homedir(), ".config", "social") }
export function envFilePath(): string { return join(configDir(), ".env") }
export function stateFilePath(): string { return join(configDir(), "state.json") }

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) { try { v = JSON.parse(v) } catch { v = v.slice(1, -1) } }
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1)
    if (v !== "") out[k] = v
  }
  return out
}

let envFileCache: { path: string; values: Record<string, string> } | null = null
function envFile(): Record<string, string> {
  const path = envFilePath()
  if (envFileCache?.path === path) return envFileCache.values
  envFileCache = { path, values: existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {} }
  return envFileCache.values
}

async function keyringGet(key: string): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const p = Bun.spawnSync(["security", "find-generic-password", "-s", "social", "-a", key, "-w"])
      if (p.exitCode === 0) return p.stdout.toString().trim() || undefined
    } else {
      const p = Bun.spawnSync(["secret-tool", "lookup", "service", "social", "key", key])
      if (p.exitCode === 0) return p.stdout.toString().trim() || undefined
    }
  } catch {}
  return undefined
}

export async function keyringSet(key: string, value: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      const p = Bun.spawnSync(["security", "add-generic-password", "-U", "-s", "social", "-a", key, "-w", value])
      return p.exitCode === 0
    }
    const p = Bun.spawnSync(["secret-tool", "store", "--label", `social ${key}`, "service", "social", "key", key], { stdin: Buffer.from(value) })
    return p.exitCode === 0
  } catch {
    return false
  }
}

/** Read one secret/config value. Returns undefined when nowhere has it. */
export async function get(key: string): Promise<string | undefined> {
  if (process.env[key]) return process.env[key]
  const f = envFile()[key]
  if (f) return f
  return keyringGet(key)
}

/** Read several; throws a single helpful error listing every missing key. */
export async function require(keys: string[], hint: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const k of keys) {
    const v = await get(k)
    if (v) out[k] = v
    else missing.push(k)
  }
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(", ")}.\n${hint}\nSet them in your environment, in ${envFilePath()}, or with \`social auth\`.`,
    )
  }
  return out
}

/** Persist a value: keyring first, .env file as the fallback (0600). */
export async function set(key: string, value: string): Promise<"keyring" | "file"> {
  if (await keyringSet(key, value)) return "keyring"
  mkdirSync(configDir(), { recursive: true })
  const current = envFile()
  current[key] = value
  writeFileSync(envFilePath(), Object.entries(current).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n")
  chmodSync(envFilePath(), 0o600)
  envFileCache = null
  return "file"
}

/** Small JSON state (cursors, cached ids, OAuth tokens with expiry). */
export function readState<T = Record<string, unknown>>(): T {
  try { return JSON.parse(readFileSync(stateFilePath(), "utf8")) as T } catch { return {} as T }
}
export function writeState(patch: Record<string, unknown>): void {
  mkdirSync(configDir(), { recursive: true })
  const next = { ...readState(), ...patch }
  // Created 0600 from the start and renamed into place: never briefly world-readable, never half-written.
  const tmp = `${stateFilePath()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, stateFilePath())
}
