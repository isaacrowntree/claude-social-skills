#!/usr/bin/env python3
"""Post to Instagram via Graph API (Business/Creator accounts only).

Flow: create media container → publish it. Images must be publicly accessible URLs.
"""
import argparse
import json
import os
import sys
import time

import requests

GRAPH_API = "https://graph.facebook.com/v22.0"


def load_env():
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())


def post_image(image_url: str, caption: str = "") -> dict:
    load_env()

    required = ["IG_USER_ID", "IG_ACCESS_TOKEN"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    user_id = os.environ["IG_USER_ID"]
    token = os.environ["IG_ACCESS_TOKEN"]

    # Step 1: Create media container
    container_resp = requests.post(
        f"{GRAPH_API}/{user_id}/media",
        data={
            "image_url": image_url,
            "caption": caption,
            "access_token": token,
        },
    )
    if container_resp.status_code != 200:
        print(f"Container error {container_resp.status_code}: {container_resp.text}", file=sys.stderr)
        sys.exit(1)

    container_id = container_resp.json()["id"]
    print(f"Media container created: {container_id}")

    # Step 2: Wait for container to be ready (video processing etc.)
    for _ in range(30):
        status_resp = requests.get(
            f"{GRAPH_API}/{container_id}",
            params={"fields": "status_code", "access_token": token},
        )
        status = status_resp.json().get("status_code")
        if status == "FINISHED":
            break
        if status == "ERROR":
            print(f"Media processing failed: {status_resp.json()}", file=sys.stderr)
            sys.exit(1)
        time.sleep(2)

    # Step 3: Publish
    publish_resp = requests.post(
        f"{GRAPH_API}/{user_id}/media_publish",
        data={"creation_id": container_id, "access_token": token},
    )
    if publish_resp.status_code == 200:
        result = publish_resp.json()
        print(json.dumps(result, indent=2))
        print(f"\nPublished! Media ID: {result.get('id')}")
        return result
    else:
        print(f"Publish error {publish_resp.status_code}: {publish_resp.text}", file=sys.stderr)
        sys.exit(1)


def post_reel(video_url: str, caption: str = "") -> dict:
    load_env()

    required = ["IG_USER_ID", "IG_ACCESS_TOKEN"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    user_id = os.environ["IG_USER_ID"]
    token = os.environ["IG_ACCESS_TOKEN"]

    container_resp = requests.post(
        f"{GRAPH_API}/{user_id}/media",
        data={
            "video_url": video_url,
            "caption": caption,
            "media_type": "REELS",
            "access_token": token,
        },
    )
    if container_resp.status_code != 200:
        print(f"Container error {container_resp.status_code}: {container_resp.text}", file=sys.stderr)
        sys.exit(1)

    container_id = container_resp.json()["id"]
    print(f"Reel container created: {container_id}")

    # Wait for video processing
    for _ in range(60):
        status_resp = requests.get(
            f"{GRAPH_API}/{container_id}",
            params={"fields": "status_code", "access_token": token},
        )
        status = status_resp.json().get("status_code")
        if status == "FINISHED":
            break
        if status == "ERROR":
            print(f"Video processing failed: {status_resp.json()}", file=sys.stderr)
            sys.exit(1)
        time.sleep(3)

    publish_resp = requests.post(
        f"{GRAPH_API}/{user_id}/media_publish",
        data={"creation_id": container_id, "access_token": token},
    )
    if publish_resp.status_code == 200:
        result = publish_resp.json()
        print(json.dumps(result, indent=2))
        return result
    else:
        print(f"Publish error {publish_resp.status_code}: {publish_resp.text}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Post to Instagram (Business accounts)")
    sub = parser.add_subparsers(dest="command", required=True)

    img = sub.add_parser("image", help="Post an image")
    img.add_argument("image_url", help="Publicly accessible image URL (JPEG)")
    img.add_argument("--caption", default="", help="Post caption")

    reel = sub.add_parser("reel", help="Post a reel")
    reel.add_argument("video_url", help="Publicly accessible video URL")
    reel.add_argument("--caption", default="", help="Reel caption")

    args = parser.parse_args()

    if args.command == "image":
        post_image(args.image_url, caption=args.caption)
    elif args.command == "reel":
        post_reel(args.video_url, caption=args.caption)


if __name__ == "__main__":
    main()
