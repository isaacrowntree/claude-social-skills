/** --json / --jq / --raw output handling, shared by every command. */
export interface OutputFlags { json?: boolean; jq?: string; raw?: boolean }

let jqReady: Promise<any> | null = null
async function jq() {
  if (!jqReady) jqReady = import("jq-web").then((m: any) => m.default ?? m)
  return jqReady
}

/**
 * Every result of a jq filter, like jq's own output stream. jq-web throws on a filter that
 * yields nothing (`.orders[]` on an empty list) and merges several results into one, so the
 * filter is collected into an array here.
 */
export async function jqAll(data: unknown, filter: string): Promise<unknown[]> {
  const out = await (await jq()).json(data, `[${filter}\n]`)
  return Array.isArray(out) ? out : []
}

export async function emit(data: unknown, flags: OutputFlags, human?: (d: any) => string): Promise<void> {
  if (flags.jq) {
    for (const out of await jqAll(data, flags.jq)) process.stdout.write((typeof out === "string" ? out : JSON.stringify(out, null, 2)) + "\n")
    return
  }
  if (flags.raw && typeof data === "string") { process.stdout.write(data); return }
  if (flags.json || !human) { process.stdout.write(JSON.stringify(data, null, 2) + "\n"); return }
  process.stdout.write(human(data) + "\n")
}

export function note(msg: string) { process.stderr.write(`! ${msg}\n`) }
