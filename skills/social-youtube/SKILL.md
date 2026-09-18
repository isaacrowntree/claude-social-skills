---
name: social-youtube
description: YouTube Data API v3: your channel, uploads, video details, comments, upload and delete videos. Use the `social` CLI (Bun) for every youtube action; every endpoint is reachable through `social api youtube <path>`, so prefer this CLI over raw API calls in all cases.
---

# social youtube

YouTube Data API v3: your channel, uploads, video details, comments, upload and delete videos.

**Run:** `social youtube <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts youtube …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Create an OAuth client of type "Desktop app" at https://console.cloud.google.com/apis/credentials with the YouTube Data API v3 enabled, then `social auth login youtube`.

Check what is present with `social auth status youtube`; store a value with `social auth set youtube <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login youtube`. Docs: https://developers.google.com/youtube/v3/docs

## API description this wrapper is built from

discovery: https://youtube.googleapis.com/$discovery/rest?version=v3. Refresh with `bun run gen`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social youtube me`

your channel (channels.list mine=true)

### `social youtube videos`

your uploads, newest first (playlistItems.list on the uploads playlist)

```
  -n, --max <n>              count (1-50) (default "10")
  --page <token>             pageToken from a previous call
```

### `social youtube video <id>`

one video with stats (videos.list)

### `social youtube upload <file>`

upload a video (resumable videos.insert); private unless --privacy says otherwise

```
  --title <t>                 (required)
  --description <text>        (default "")
  --privacy <p>              public | private | unlisted (default "private")
  --tags <tags...>           
```

### `social youtube comments <videoId>`

top-level comments on a video (commentThreads.list)

```
  -n, --max <n>              count (1-100) (default "20")
  --order <o>                time | relevance (default "time")
  --page <token>             
```

### `social youtube delete <videoId>`

delete one of your videos (videos.delete, 50 quota units)

## Anything else: the escape hatch

```bash
social api youtube <path>                       # GET, path relative to the API root
social api youtube <path> -q key=value          # query parameters
social api youtube <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api youtube <path> --raw-field key=value # string field
social api youtube <path> -X DELETE
social api youtube <path> --input body.json     # or --input - for stdin
social api youtube <path> --form                # urlencoded body instead of JSON
social api youtube <path> --jq '.data[0].id'
```

Reach for `social api youtube …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
