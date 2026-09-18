---
name: social-email
description: Email through the himalaya CLI: list, read, search, trace headers, send, reply, move, flag, delete. Use the `social` CLI (Bun) for every email action; every endpoint is reachable through `social api email <path>`, so prefer this CLI over raw API calls in all cases.
---

# social email

Email through the himalaya CLI: list, read, search, trace headers, send, reply, move, flag, delete.

**Run:** `social email <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts email …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- none; auth lives in the underlying tool's own config

Nothing to store here: accounts, servers and passwords live in himalaya's TOML config. Run `himalaya account configure` (or bare `himalaya`) to add one, `himalaya account list` to see them.

Check what is present with `social auth status email`; store a value with `social auth set email <KEY> <value>` (OS keyring, else `~/.config/social/.env`). Docs: https://github.com/pimalaya/himalaya

## API description this wrapper is built from

No machine-readable spec: himalaya --help (v2.1.0).

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social email accounts`

accounts in himalaya's config

### `social email folders`

mailboxes (folders) of an account

```
  --counts                   also fetch total/unread per mailbox (one IMAP STATUS each)
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email list`

newest envelopes first (* unread, ! flagged, @ attachment)

```
  -f, --folder <name>        mailbox name or alias (default: inbox)
  -s, --page-size <n>        envelopes per page (himalaya default 25)
  -p, --page <n>             page number from 1
  --has-attachment           populate the attachment marker (extra lookup per envelope)
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email search <query>...`

search envelopes: `from x and subject y`, `after 2026-01-01`, `flag seen`, `not …`, `order by date desc`

```
  -f, --folder <name>        mailbox name or alias (default: inbox)
  -s, --page-size <n>        envelopes per page
  -p, --page <n>             page number from 1
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email read <id>`

read a message (leaves it unread unless --seen)

```
  -f, --folder <name>        mailbox name or alias (default: inbox)
  --preview                  accepted for compatibility: v2 reads never mark seen
  --seen                     mark the message seen while reading
  -H, --headers <names...>   print only these headers, from the raw message
  --raw                      the original RFC 5322 bytes
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email trace <id>`

where a message came from: Received chain, SPF/DKIM/DMARC results, Return-Path, originating IP, mailer

```
  -f, --folder <name>        mailbox name or alias (default: inbox)
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email attachments <id>`

list a message's attachments; ids feed `himalaya attachment download <msg> <id>`

```
  -f, --folder <name>        mailbox name or alias (default: inbox)
  -d, --download [dir]       download all to a directory (default: himalaya's downloads-dir)
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email send <spec>`

send a message from a JSON spec {to, cc, bcc, subject, body, from, attachments}: a file path, - for stdin, or inline JSON

```
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email reply <id>`

reply to a message; recipients come from Reply-To/From unless --to is given

```
  -f, --folder <name>        mailbox of the source (default: inbox)
  -b, --body <text>          reply text (stdin if omitted)
  -t, --to <addr...>         override recipients
  --cc <addr...>             
  --bcc <addr...>            
  --attach <file...>         
  --bottom                   quote the original above your text
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email forward <id>`

forward a message (himalaya adds no recipient itself, so --to is required)

```
  -t, --to <addr...>         recipient(s) (required)
  -f, --folder <name>        mailbox of the source (default: inbox)
  -b, --body <text>          note above the forwarded text (default "")
  --cc <addr...>             
  --bcc <addr...>            
  --attach <file...>         
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email move <id> <folder>`

move a message to another mailbox

```
  -f, --folder <name>        source mailbox (default: inbox)
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email flag <id>`

add or remove flags: seen, answered, flagged, draft

```
  --add <flags...>           
  --remove <flags...>        
  -f, --folder <name>        mailbox name or alias (default: inbox)
  -a, --account <name>       himalaya account (default: the config's default account)
```

### `social email delete <id>`

delete a message (moves to trash; permanent if already in trash)

```
  -f, --folder <name>        mailbox name or alias (default: inbox)
  -a, --account <name>       himalaya account (default: the config's default account)
```

## Anything else: the escape hatch

```bash
social api email <path>                       # GET, path relative to the API root
social api email <path> -q key=value          # query parameters
social api email <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api email <path> --raw-field key=value # string field
social api email <path> -X DELETE
social api email <path> --input body.json     # or --input - for stdin
social api email <path> --form                # urlencoded body instead of JSON
social api email <path> --jq '.data[0].id'
```

Reach for `social api email …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
