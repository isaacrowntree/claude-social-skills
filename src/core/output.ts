/** --json / --jq / --raw output handling, shared by every command. */
export interface OutputFlags { json?: boolean; jq?: string; raw?: boolean }

let jqReady: Promise<any> | null = null
async function jq() {
  if (!jqReady) jqReady = import("jq-web").then((m: any) => m.default ?? m)
  return jqReady
}

export async function emit(data: unknown, flags: OutputFlags, human?: (d: any) => string): Promise<void> {
  if (flags.jq) {
    const j = await jq()
    const out = await j.json(data, flags.jq)
    if (typeof out === "string") process.stdout.write(out + "\n")
    else process.stdout.write(JSON.stringify(out, null, 2) + "\n")
    return
  }
  if (flags.raw && typeof data === "string") { process.stdout.write(data); return }
  if (flags.json || !human) { process.stdout.write(JSON.stringify(data, null, 2) + "\n"); return }
  process.stdout.write(human(data) + "\n")
}

export function note(msg: string) { process.stderr.write(`! ${msg}\n`) }
