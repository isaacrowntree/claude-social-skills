---
name: himalaya-email
description: Himalaya CLI email client. Use when the user asks about emails, wants to read messages, check inbox, trace email origins, or manage email from the terminal.
---

# Himalaya Email CLI

Use `himalaya` (v1.2.0) for all email operations. The user's account should be configured in `~/Library/Application Support/himalaya/config.toml`.

## When to Use

- User asks about emails, inbox, or messages
- User wants to read, search, or list emails
- User wants to trace email origin or check headers
- User mentions a sender or subject and wants to find/read the email

## Core Commands

```bash
# List recent emails (default: INBOX)
himalaya envelope list --page-size 20

# List emails in a specific folder
himalaya envelope list --folder "Sent" --page-size 20

# Read an email by ID (marks as seen)
himalaya message read <ID>

# Read without marking as seen (preview mode)
himalaya message read -p <ID>

# Read with no headers (body only)
himalaya message read --no-headers <ID>

# Read with specific headers visible
himalaya message read -H "From" -H "To" -H "Subject" -H "Date" <ID>

# Search/filter envelopes (if supported by backend)
himalaya envelope list --page-size 50
```

## Tracing Email Origin / Headers

When the user wants to know where an email came from, read it with authentication headers:

```bash
himalaya message read -p \
  -H "From" \
  -H "Reply-To" \
  -H "Return-Path" \
  -H "Received" \
  -H "X-Originating-IP" \
  -H "Authentication-Results" \
  -H "Received-SPF" \
  -H "DKIM-Signature" \
  -H "ARC-Authentication-Results" \
  -H "Message-ID" \
  -H "X-Mailer" \
  <ID>
```

### How to Interpret Headers

- **SPF (Sender Policy Framework):** `spf=pass` means the sending IP is authorized by the domain. Look for the IP in `Received-SPF`.
- **DKIM (DomainKeys Identified Mail):** `dkim=pass` means the email signature is valid and the content wasn't tampered with. Check `header.d=` for the signing domain.
- **DMARC:** `dmarc=pass` means the domain's SPF/DKIM alignment policy passed.
- **ARC (Authenticated Received Chain):** Shows authentication survived forwarding.
- **Return-Path:** The actual envelope sender (where bounces go).
- **Received headers:** Read bottom-to-top to trace the email's path through servers.
- **Message-ID:** Unique identifier; the domain after `@` often reveals the originating mail system.
- **X-Originating-IP:** If present, the sender's actual IP address.

### Key Things to Report

1. Whether SPF/DKIM/DMARC all pass (legitimate) or fail (suspicious)
2. The originating IP and what domain it belongs to
3. Whether the From address matches the actual sending infrastructure
4. If it was forwarded, the original sender chain

## Output Formats

```bash
# JSON output (useful for parsing)
himalaya envelope list --output json --page-size 10

# Plain text (default)
himalaya envelope list --output plain --page-size 10
```

## Sending & Replying

The `reply` command requires a TTY for interactive send/save prompt, so use `message send` with raw MIME instead:

```bash
# Reply to an email (construct raw MIME)
# 1. Get the Message-ID and References from the original
himalaya message read -p -H "Message-ID" -H "References" -H "In-Reply-To" <ID>

# 2. Send a raw reply with proper threading headers
cat <<'RAWMSG' | himalaya message send
From: Your Name <you@example.com>
To: Recipient <recipient@example.com>
Subject: Re: Original Subject
In-Reply-To: <original-message-id@example.com>
References: <previous-refs> <original-message-id@example.com>
Content-Type: text/plain; charset=utf-8

Reply body here.
RAWMSG
```

**Always ask the user to approve the draft before sending.**

### Threading Rules
- Set `In-Reply-To` to the Message-ID of the email you're replying to
- Set `References` to the original's References + its Message-ID (space-separated)
- Use `Re:` prefix on Subject to match the thread

## Gmail Folder Aliases

Config maps standard folder names to Gmail's IMAP folders (via `folder.aliases`, note the plural):
- `sent` → `[Gmail]/Sent Mail`
- `drafts` → `[Gmail]/Drafts`
- `trash` → `[Gmail]/Bin` (or `[Gmail]/Trash` depending on locale)
- `spam` → `[Gmail]/Spam`

Config location: `~/Library/Application Support/himalaya/config.toml`

## Important Notes

- Use `-p` (preview) flag when just investigating — avoids marking emails as read
- The `--header` flag is `-H` (short form), not `--headers` (that doesn't exist)
- There is no `--raw` flag — use `-H` with specific header names instead
- There is no `--all` flag on `message send` — construct To/Cc headers manually for reply-all
- IDs are numeric and correspond to IMAP sequence numbers
- Default folder is INBOX; use `--folder` to access others
- **Gmail duplicate sent mail:** `save-copy` must be `false` in the himalaya config. Gmail's SMTP automatically saves sent messages to Sent Mail — if himalaya also saves a copy via IMAP, the message appears twice. The config should have `message.send.save-copy = false`.
