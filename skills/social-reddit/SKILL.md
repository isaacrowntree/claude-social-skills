---
name: social-reddit
description: Reddit: post, comment, delete, inbox, home feed and subreddit listings, plus any Data API path. Use the `social` CLI (Bun) for every reddit action; every endpoint is reachable through `social api reddit <path>`, so prefer this CLI over raw API calls in all cases.
---

# social reddit

Reddit: post, comment, delete, inbox, home feed and subreddit listings, plus any Data API path.

**Run:** `social reddit <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts reddit …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`

Create an app at https://www.reddit.com/prefs/apps (type "script" for the password grant, or "web app" with redirect uri http://localhost:8765/callback for `social auth login reddit`). Reddit also requires access approval since Nov 2025: https://support.reddithelp.com/hc/en-us/requests/new REDDIT_USERNAME/REDDIT_PASSWORD are only needed for the script (password) grant.

Check what is present with `social auth status reddit`; store a value with `social auth set reddit <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login reddit`. Docs: https://www.reddit.com/dev/api

## API description this wrapper is built from

No machine-readable spec: https://www.reddit.com/dev/api (HTML only; no OpenAPI).

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social reddit me`

the authenticated account (GET /api/v1/me)

### `social reddit post <subreddit> <title>`

submit a text or link post to a subreddit

```
  --text <markdown>          self-post body (kind=self)
  --url <url>                link post (kind=link)
  --nsfw                     
  --spoiler                  
  --flair-id <id>            
  --resubmit                 allow a URL that was already posted to this subreddit
```

### `social reddit comment <thing_id> <text>`

reply to a post (t3_…), comment (t1_…) or message (t4_…) by fullname

### `social reddit delete <thing_id>`

delete your own post or comment by fullname

### `social reddit inbox`

unread messages, comment replies and mentions

```
  -n, --max <n>              count (max 100) (default "25")
  --all                      the whole inbox, not only unread
```

### `social reddit feed`

your home feed (hot)

```
  -n, --max <n>              count (max 100) (default "25")
```

### `social reddit subreddit <name>`

a subreddit's listing (hot by default)

```
  -n, --max <n>              count (max 100) (default "25")
  --sort <s>                 hot | new | rising | top | controversial (default "hot")
```

## Anything else: the escape hatch

```bash
social api reddit <path>                       # GET, path relative to the API root
social api reddit <path> -q key=value          # query parameters
social api reddit <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api reddit <path> --raw-field key=value # string field
social api reddit <path> -X DELETE
social api reddit <path> --input body.json     # or --input - for stdin
social api reddit <path> --form                # urlencoded body instead of JSON
social api reddit <path> --jq '.data[0].id'
```

Reach for `social api reddit …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
