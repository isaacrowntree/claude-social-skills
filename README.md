# claude-social-skills

Claude Code plugin marketplace for posting to Twitter/X, Reddit, Facebook, Instagram, and eBay.

No MCP servers. Just Python scripts + a skill that teaches Claude how to use them.

## Install

In Claude Code:

```
/plugin marketplace add isaacrowntree/claude-social-skills
/plugin install social-post@social-skills
```

Then install the Python dependencies (Claude will prompt you on first use, or run manually):

```bash
pip install requests requests-oauthlib
```

## Setup credentials

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

# eBay
export EBAY_CLIENT_ID=...
export EBAY_CLIENT_SECRET=...
export EBAY_RUNAME=...
```

| Platform | Where to get credentials | Account type |
|----------|-------------------------|--------------|
| **Twitter/X** | [Developer Portal](https://developer.x.com/en/portal/dashboard) | Any (free tier: ~50 posts/month) |
| **Reddit** | [App Preferences](https://www.reddit.com/prefs/apps) — create "script" type | Any (2FA must be disabled) |
| **Facebook** | [Graph API Explorer](https://developers.facebook.com/tools/explorer/) | Page (not personal) |
| **Instagram** | Same as Facebook, linked IG account | Business/Creator only |
| **eBay** | [Developer Program](https://developer.ebay.com) | Any eBay account |

### eBay setup

eBay uses OAuth 2.0 with browser-based consent, which is different from the other platforms:

1. Create an app at [developer.ebay.com](https://developer.ebay.com) to get your client ID and secret
2. Create a RuName with redirect URL set to `http://localhost:8888/callback`
3. Export `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`
4. Run the auth flow (opens browser, you log in, tokens are saved automatically):
   ```bash
   python3 plugins/social-post/scripts/ebay_list.py auth
   ```
5. Tokens are saved to `~/.ebay_tokens.json` — access token refreshes automatically

Set `EBAY_SANDBOX=true` to test against eBay's sandbox environment.

## Usage

In Claude Code, use `/social-post:social-post` or just ask naturally:

```
> /social-post:social-post tweet "Just shipped a new feature!"
> Post this to Reddit r/programming: "Check out this tool..."
> Share on Twitter and Reddit: "Big announcement..."
> List my GoPro on eBay for $299, condition is like new
```

## Direct script usage

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

# eBay (requires auth first: ebay_list.py auth)
python3 scripts/ebay_list.py list \
  --title "GoPro Hero 12 Black" \
  --description "Brand new, sealed in box." \
  --price 299.99 \
  --condition NEW \
  --image "https://example.com/photo.jpg" \
  --marketplace US
```

## Repo structure

```
claude-social-skills/
├── .claude-plugin/
│   └── marketplace.json           # Marketplace catalog
└── plugins/
    └── social-post/
        ├── .claude-plugin/
        │   └── plugin.json        # Plugin manifest
        ├── skills/
        │   └── social-post/
        │       └── SKILL.md       # Skill instructions
        ├── scripts/
        │   ├── tweet.py           # Twitter/X (OAuth 1.0a)
        │   ├── reddit_post.py     # Reddit (OAuth2)
        │   ├── fb_post.py         # Facebook Pages (Graph API v24.0)
        │   ├── ig_post.py         # Instagram Business (Graph API v24.0)
        │   └── ebay_list.py       # eBay (Inventory API, OAuth 2.0)
        ├── requirements.txt
        └── .env.example
```

## Platform limitations

- **Twitter**: Free tier allows ~50 posts/month. OAuth 1.0a required for posting.
- **Reddit**: API key self-service was restricted Nov 2025. Existing keys still work. 2FA must be disabled.
- **Facebook**: Page posting only (no personal profiles via API). 200 calls/hour.
- **Instagram**: Business accounts only. Must be linked to a Facebook Page. Images must be publicly hosted JPEG URLs. 25 posts/day max.
- **eBay**: Free API access. OAuth browser consent required once, then auto-refreshes for ~18 months. Supports fixed-price and auction listings.

## License

MIT
