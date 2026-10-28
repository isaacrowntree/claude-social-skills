/**
 * Discord, generated from Discord's official OpenAPI description
 * (github.com/discord/discord-api-spec, HTTP API v10). Every operation is a
 * `social discord call <id>` away; this file only holds auth.
 *
 * Auth: a bot token (discord.com/developers/applications → your app → Bot → Reset Token),
 * sent as `Authorization: Bot <token>`. The bot only sees servers it has been invited to
 * (OAuth2 → URL Generator with the `bot` scope and the permissions it needs).
 */
import type { Command } from "commander"
import type { Platform } from "../../core/platform.ts"
import { makeHttp, type Http } from "../../core/http.ts"
import * as config from "../../core/config.ts"
import { emit } from "../../core/output.ts"
import { Generated, registerGenerated } from "../../core/openapi.ts"

const isDiscordHost = (h: string) => ["discord.com", "discordapp.com"].some((d) => h === d || h.endsWith("." + d))

async function client(baseUrl = "https://discord.com/api/v10"): Promise<Http> {
  const { DISCORD_BOT_TOKEN } = await config.require(["DISCORD_BOT_TOKEN"], "Create an application at https://discord.com/developers/applications, add a Bot, copy its token, and invite it to your server (OAuth2 → URL Generator, scope `bot`).")
  // Discord asks bots to identify themselves this way: https://discord.com/developers/docs/reference#user-agent
  return makeHttp({ baseUrl, allowHost: isDiscordHost, userAgent: "DiscordBot (https://github.com/isaacrowntree/claude-social-skills, 2.0)", headers: () => ({ authorization: `Bot ${DISCORD_BOT_TOKEN}` }) })
}

export const generated = new Generated({ name: "discord", indexFile: new URL("./ops.gen.json", import.meta.url).pathname, client: async (_op, base) => client(base) })

export const discord: Platform = {
  name: "discord",
  summary: "Discord: every HTTP API operation (messages, channels, servers, threads, webhooks, members…) as a bot, generated from Discord's OpenAPI description",
  spec: { kind: "openapi", source: "github.com/discord/discord-api-spec specs/openapi.json; pinned in spec-pins.json" },
  credentials: { keys: ["DISCORD_BOT_TOKEN"], hint: "A bot token from https://discord.com/developers/applications (your app → Bot → Reset Token). Invite the bot to a server with OAuth2 → URL Generator (scope `bot`) before it can read or post there.", docsUrl: "https://discord.com/developers/docs/reference" },
  http: () => client(),
  async whoami() {
    const r: any = await generated.call(await generated.find("get_my_user") as any, { params: {} })
    return { id: r.id, username: r.username, bot: r.bot }
  },
  async skill() {
    return {
      body: `## Recipes

- Who is the bot: \`social discord me\`
- Servers the bot is in: \`social discord call list_my_guilds --jq '.[] | {id, name}'\`
- Channels in a server: \`social discord call list_guild_channels -p guild_id=<id> --jq '.[] | {id, name, type}'\`
- Post a message: \`social discord call create_message -p channel_id=<id> -f content='hello'\` (add \`--dry-run\` first to see the request)
- Read recent messages: \`social discord call list_messages -p channel_id=<id> -p limit=20 --jq '.[] | {author: .author.username, content}'\` (needs the Message Content intent for other people's text)
`,
    }
  },
  register(cmd: Command) {
    registerGenerated(cmd, generated)
    cmd.command("me").description("the bot user (get_my_user)").option("--json").action(async (o) => { await emit(await discord.whoami!(), o, (d) => `${d.username} (${d.id})${d.bot ? " [bot]" : ""}`) })
  },
}
