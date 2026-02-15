# claude-social-skills

Claude Code plugin marketplace for posting to Twitter/X, Reddit, Facebook, and Instagram.

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
```

| Platform | Where to get credentials | Account type |
|----------|-------------------------|--------------|
| **Twitter/X** | [Developer Portal](https://developer.x.com/en/portal/dashboard) | Any (free tier: ~50 posts/month) |
| **Reddit** | [App Preferences](https://www.reddit.com/prefs/apps) — create "script" type | Any |
| **Facebook** | [Graph API Explorer](https://developers.facebook.com/tools/explorer/) | Page (not personal) |
| **Instagram** | Same as Facebook, linked IG account | Business/Creator only |

## Usage

In Claude Code, use `/social-post:social-post` or just ask naturally:

```
> /social-post:social-post tweet "Just shipped a new feature!"
> Post this to Reddit r/programming: "Check out this tool..."
> Share on Twitter and Reddit: "Big announcement..."
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
        │   ├── fb_post.py         # Facebook Pages (Graph API)
        │   └── ig_post.py         # Instagram Business (Graph API)
        ├── requirements.txt
        └── .env.example
```

## Platform limitations

- **Twitter**: Free tier allows ~50 posts/month. OAuth 1.0a required for posting.
- **Reddit**: API key self-service was restricted Nov 2025. Existing keys still work.
- **Facebook**: Page posting only (no personal profiles via API). 200 calls/hour.
- **Instagram**: Business accounts only. Must be linked to a Facebook Page. Images must be publicly hosted JPEG URLs. 25 posts/day max.

## License

MIT
