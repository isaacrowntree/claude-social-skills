#!/usr/bin/env python3
"""Post a tweet via Twitter API v2 (OAuth 1.0a User Context)."""
import argparse
import json
import os
import sys

from requests_oauthlib import OAuth1Session


def load_env():
    """Load .env file from repo root if env vars not already set."""
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())


def tweet(text: str, reply_to: str | None = None) -> dict:
    load_env()

    required = [
        "TWITTER_API_KEY",
        "TWITTER_API_SECRET",
        "TWITTER_ACCESS_TOKEN",
        "TWITTER_ACCESS_TOKEN_SECRET",
    ]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("Copy .env.example to .env and fill in your credentials.", file=sys.stderr)
        sys.exit(1)

    oauth = OAuth1Session(
        os.environ["TWITTER_API_KEY"],
        client_secret=os.environ["TWITTER_API_SECRET"],
        resource_owner_key=os.environ["TWITTER_ACCESS_TOKEN"],
        resource_owner_secret=os.environ["TWITTER_ACCESS_TOKEN_SECRET"],
    )

    payload = {"text": text}
    if reply_to:
        payload["reply"] = {"in_reply_to_tweet_id": reply_to}

    resp = oauth.post("https://api.x.com/2/tweets", json=payload)

    if resp.status_code == 201:
        data = resp.json()
        tweet_id = data["data"]["id"]
        print(json.dumps(data, indent=2))
        print(f"\nhttps://x.com/i/status/{tweet_id}")
        return data
    else:
        print(f"Error {resp.status_code}: {resp.text}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Post a tweet")
    parser.add_argument("text", help="Tweet text (max 280 chars)")
    parser.add_argument("--reply-to", help="Tweet ID to reply to")
    args = parser.parse_args()

    if len(args.text) > 280:
        print(f"Tweet is {len(args.text)} chars (max 280)", file=sys.stderr)
        sys.exit(1)

    tweet(args.text, reply_to=args.reply_to)


if __name__ == "__main__":
    main()
