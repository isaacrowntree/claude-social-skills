/**
 * The browser half of an OAuth authorization-code sign-in: serve the redirect URI on
 * localhost, open the consent page, and wait for the code. Used by eBay, Pinterest and
 * Etsy; each platform does its own token exchange, since their token endpoints differ.
 */
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CALLBACK_PAGE, stopCallbackServer } from "./http.ts"
import { note } from "./output.ts"

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** PKCE (S256): send `challenge` with the consent URL and `verifier` with the token exchange. */
export function pkce(): { verifier: string; challenge: string } {
  const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }
}

/**
 * Serve `listen` (e.g. https://localhost:8888/callback; https gets a throwaway self-signed
 * certificate), open the URL `consentUrl(state)` builds, and resolve with the code. The
 * `state` check means nothing else on the machine can feed in a code of its own.
 */
export async function browserConsent(o: { listen: string; consentUrl: (state: string) => string; what: string; timeoutMs?: number }): Promise<string> {
  const listen = new URL(o.listen)
  if (!["localhost", "127.0.0.1"].includes(listen.hostname)) throw new Error(`the redirect URI must be on localhost to be served here, not ${listen.host}`)
  const https = listen.protocol === "https:"
  const dir = https ? mkdtempSync(join(tmpdir(), "social-oauth-")) : undefined
  try {
    let tls: { key: ReturnType<typeof Bun.file>; cert: ReturnType<typeof Bun.file> } | undefined
    if (dir) {
      const key = join(dir, "key.pem"), cert = join(dir, "cert.pem")
      const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost"])
      if (gen.exitCode !== 0) throw new Error(`openssl is needed to serve ${o.listen}`)
      tls = { key: Bun.file(key), cert: Bun.file(cert) }
    }
    const state = randomBytes(16).toString("hex")
    let resolveCode!: (c: string) => void
    const code = new Promise<string>((r) => (resolveCode = r))
    const server = Bun.serve({
      port: Number(listen.port || (https ? 443 : 80)), hostname: listen.hostname, ...(tls ? { tls } : {}),
      fetch(req) {
        const u = new URL(req.url)
        const c = u.searchParams.get("code")
        if (c && u.searchParams.get("state") === state) { resolveCode(c); return new Response("<h1>Authorised. You can close this tab.</h1>", { headers: CALLBACK_PAGE }) }
        const why = c ? "state mismatch" : u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? "no code in the callback"
        return new Response(`<h1>Authorisation failed: ${escapeHtml(why)}</h1>`, { status: 400, headers: CALLBACK_PAGE })
      },
    })
    const url = o.consentUrl(state)
    note(`Opening the browser for ${o.what} authorisation.${https ? " Accept the self-signed certificate warning for localhost." : ""}\n${url}`)
    Bun.spawn(["open", url])
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out waiting for the ${o.what} callback`)), o.timeoutMs ?? 180_000) })
    return await Promise.race([code, timeout]).finally(() => { clearTimeout(timer); stopCallbackServer(server) })
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }) }
}
