# claude-social-skills

Claude Code skill for posting to Twitter/X, Reddit, Facebook, and Instagram from the terminal.

No MCP servers. Just Python scripts + a skill file that teaches Claude how to use them.

## Install

```bash
git clone https://github.com/YOUR_USERNAME/claude-social-skills.git ~/src/claude-social-skills
cd ~/src/claude-social-skills
./install.sh
```

This installs Python dependencies (`requests`, `requests-oauthlib`) and symlinks the skill into `~/.claude/skills/`.

## Setup credentials

Copy `.env.example` to `.env` and fill in credentials for the platforms you want:

```bash
cp .env.example .env
# edit .env with your credentials
```

| Platform | Where to get credentials | Account type |
|----------|-------------------------|--------------|
| **Twitter/X** | [Developer Portal](https://developer.x.com/en/portal/dashboard) | Any (free tier: ~50 posts/month) |
| **Reddit** | [App Preferences](https://www.reddit.com/prefs/apps) — create "script" type | Any |
| **Facebook** | [Graph API Explorer](https://developers.facebook.com/tools/explorer/) | Page (not personal) |
| **Instagram** | Same as Facebook, linked IG account | Business/Creator only |

## Usage

In Claude Code, use `/social-post` or just ask naturally:

```
> /social-post tweet "Just shipped a new feature!"
> Post this to Reddit r/programming: "Check out this tool..."
> Share on Twitter and Reddit: "Big announcement..."
```

## Direct script usage

You can also call the scripts directly:

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

## Platform limitations

- **Twitter**: Free tier allows ~50 posts/month. OAuth 1.0a required for posting.
- **Reddit**: API key self-service was restricted Nov 2025. Existing keys still work.
- **Facebook**: Page posting only (no personal profiles via API). 200 calls/hour.
- **Instagram**: Business accounts only. Must be linked to a Facebook Page. Images must be publicly hosted JPEG URLs. 25 posts/day max.

## License

MIT
