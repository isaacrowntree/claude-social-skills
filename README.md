# claude-social-skills

Claude Code plugin marketplace for social media, email, and e-commerce.

No MCP servers. Just scripts + skills that teach Claude how to use them.

## Plugins

| Plugin | Description |
|--------|-------------|
| **social-post** | Post to Twitter/X, Reddit, Facebook, and Instagram |
| **ebay-listing** | List items for sale on eBay |
| **himalaya-email** | Read, send, and manage email using the Himalaya CLI |

## Install

In Claude Code:

```
/plugin marketplace add isaacrowntree/claude-social-skills
/plugin install social-post@social-skills
/plugin install ebay-listing@social-skills
/plugin install himalaya-email@social-skills
```

## social-post

### Dependencies

```bash
pip install requests requests-oauthlib
```

### Credentials

Export environment variables for the platforms you want to use:

```bash
# Twitter/X
export TWITTER_API_KEY=...
export TWITTER_API_SECRET=...
export TWITTER_ACCESS_TOKEN=...
export TWITTER_ACCESS_TOKEN_SECRET=...

# Reddit
export REDDIT_CLIENT_ID=...
export REDDIT_CLIENT_SECRET=...
export REDDIT_USERNAME=...
export REDDIT_PASSWORD=...

# Facebook
export FB_PAGE_ID=...
export FB_ACCESS_TOKEN=...

# Instagram
export IG_USER_ID=...
export IG_ACCESS_TOKEN=...
```

| Platform | Where to get credentials | Account type |
|----------|-------------------------|--------------|
| **Twitter/X** | [Developer Portal](https://developer.x.com/en/portal/dashboard) | Any (free tier: ~50 posts/month) |
| **Reddit** | [App Preferences](https://www.reddit.com/prefs/apps) — create "script" type | Any (2FA must be disabled) |
| **Facebook** | [Graph API Explorer](https://developers.facebook.com/tools/explorer/) | Page (not personal) |
| **Instagram** | Same as Facebook, linked IG account | Business/Creator only |

### Usage

```
> Post this to Reddit r/programming: "Check out this tool..."
> Share on Twitter and Reddit: "Big announcement..."
```

### Direct script usage

```bash
# Twitter
python3 scripts/tweet.py "Hello world"

# Reddit
python3 scripts/reddit_post.py post programming "My title" --text "Post body"
python3 scripts/reddit_post.py comment t3_abc123 "Nice post!"

# Facebook
python3 scripts/fb_post.py "Page update" --link "https://example.com"

# Instagram (image must be a public URL)
python3 scripts/ig_post.py image "https://example.com/photo.jpg" --caption "Caption"
python3 scripts/ig_post.py reel "https://example.com/video.mp4" --caption "Reel caption"
```

### Platform limitations

- **Twitter**: Free tier allows ~50 posts/month. OAuth 1.0a required for posting.
- **Reddit**: API key self-service was restricted Nov 2025. Existing keys still work. 2FA must be disabled.
- **Facebook**: Page posting only (no personal profiles via API). 200 calls/hour.
- **Instagram**: Business accounts only. Must be linked to a Facebook Page. Images must be publicly hosted JPEG URLs. 25 posts/day max.

## ebay-listing

List items for sale on eBay. Supports fixed-price and auction listings with local image upload, product photo cleanup, and multiple marketplaces.

### Dependencies

```bash
pip install requests Pillow
```

### Setup

1. Create an app at [developer.ebay.com](https://developer.ebay.com) (free, no API fees)
2. Go to the **User Tokens** tab > **Auth'n'Auth** > **Sign in to Production**
3. Sign in with your eBay account to generate a token
4. Export it:
   ```bash
   export EBAY_AUTH_TOKEN=<your-token>
   ```

That's it. The token lasts ~18 months and the script uses eBay's Trading API (XML) with it.

> **Why Auth'n'Auth?** The OAuth 2.0 alternative requires a browser-based redirect flow that's finicky on localhost. Auth'n'Auth is simpler for personal use — one token, no callback server. The script supports both methods and auto-detects based on which env vars are set.

### Usage

```
> List my GoPro on eBay for $299, condition is like new
> Create a draft eBay listing for this camera with these photos
> Clean up my product photos in this folder
```

### Direct script usage

```bash
# Create a listing
python3 scripts/ebay_list.py list \
  --title "GoPro Hero 12 Black" \
  --description "Brand new, sealed in box." \
  --price 299.99 \
  --condition NEW \
  --image "https://example.com/photo.jpg" \
  --marketplace US \
  --currency USD

# Photo cleanup (auto white balance, contrast, sharpening)
python3 scripts/photo_cleanup.py <directory|file>
```

### Listing options

| Option | Required | Description |
|--------|----------|-------------|
| `--title` | Yes | Item title (max 80 chars) |
| `--description` | Yes | Item description (max 4000 chars) |
| `--price` | Yes | Listing price |
| `--condition` | Yes | NEW, LIKE_NEW, USED_EXCELLENT, USED_VERY_GOOD, USED_GOOD, FOR_PARTS_OR_NOT_WORKING, etc. |
| `--image` | Yes | HTTPS image URL (repeatable for multiple images) |
| `--category` | No | eBay category ID |
| `--marketplace` | No | US (default), UK, AU, CA, DE, FR, IT, ES |
| `--currency` | No | USD (default), GBP, AUD, CAD, EUR |
| `--format` | No | FIXED_PRICE (default) or AUCTION |
| `--quantity` | No | Number available (default: 1) |
| `--sku` | No | Custom SKU (auto-generated if omitted) |
| `--brand` | No | Brand name |
| `--draft` | No | Create offer without publishing (for review) |

### Platform notes

- Free API access, no fees. Auth'n'Auth token lasts ~18 months.
- Supports fixed-price and auction listings.
- Includes `photo_cleanup.py` for auto white balance, contrast, brightness, and sharpening of product photos.
- Also supports OAuth 2.0 (Inventory API) if you set `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME` instead — auto-detects based on which env vars are present.

## himalaya-email

Read, send, and manage email from Claude Code using the [himalaya](https://github.com/pimalaya/himalaya) CLI. No scripts needed — this plugin teaches Claude how to use the himalaya commands directly.

### Prerequisites

1. Install himalaya (v1.2.0+):
   ```bash
   brew install himalaya
   ```
2. Configure your email account in `~/.config/himalaya/config.toml` (or `~/Library/Application Support/himalaya/config.toml` on macOS). See the [himalaya docs](https://github.com/pimalaya/himalaya) for config examples.

### Features

- List and read emails from any folder (INBOX, Sent, Drafts, etc.)
- Send emails and reply to threads with proper threading headers
- Trace email origins — inspect SPF, DKIM, DMARC, and Received headers
- Preview mode (`-p` flag) to read without marking as seen
- Gmail folder alias support (Sent Mail, Drafts, Bin, Spam)
- JSON output for programmatic use

### Usage

```
> Check my inbox
> Read the latest email from GitHub
> Reply to that email saying thanks
> Where did this email actually come from? Check the headers
> Show me emails in my Sent folder
```

### Platform notes

- Works with any IMAP/SMTP email provider (Gmail, Outlook, Fastmail, etc.)
- Gmail users: set `message.send.save-copy = false` in config to avoid duplicate sent messages.
- No API keys needed — uses standard IMAP/SMTP with app passwords.

## Repo structure

```
claude-social-skills/
├── .claude-plugin/
│   └── marketplace.json           # Marketplace catalog
└── plugins/
    ├── social-post/
    │   ├── .claude-plugin/
    │   │   └── plugin.json        # Plugin manifest
    │   ├── skills/
    │   │   └── social-post/
    │   │       └── SKILL.md       # Skill instructions
    │   ├── scripts/
    │   │   ├── tweet.py           # Twitter/X (OAuth 1.0a)
    │   │   ├── reddit_post.py     # Reddit (OAuth2)
    │   │   ├── fb_post.py         # Facebook Pages (Graph API v24.0)
    │   │   └── ig_post.py         # Instagram Business (Graph API v24.0)
    │   ├── requirements.txt
    │   └── .env.example
    ├── ebay-listing/
    │   ├── .claude-plugin/
    │   │   └── plugin.json        # Plugin manifest
    │   ├── skills/
    │   │   └── ebay-listing/
    │   │       └── SKILL.md       # Skill instructions
    │   ├── scripts/
    │   │   ├── ebay_list.py       # eBay (Trading API + Inventory API)
    │   │   └── photo_cleanup.py   # Product photo auto-cleanup
    │   ├── tests/
    │   │   └── test_ebay_list.py
    │   ├── requirements.txt
    │   └── .env.example
    └── himalaya-email/
        ├── .claude-plugin/
        │   └── plugin.json        # Plugin manifest
        └── skills/
            └── himalaya-email/
                └── SKILL.md       # Skill instructions (uses himalaya CLI)
```

## License

MIT
