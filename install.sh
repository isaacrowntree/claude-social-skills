#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"

echo "Installing claude-social-skills..."

# Install Python dependencies
if command -v python3 &>/dev/null; then
    echo "Installing Python dependencies..."
    python3 -m pip install -q -r "$REPO_DIR/requirements.txt"
else
    echo "Error: python3 not found. Please install Python 3.9+."
    exit 1
fi

# Make scripts executable
chmod +x "$REPO_DIR"/scripts/*.py

# Create skills directory if needed
mkdir -p "$SKILLS_DIR"

# Symlink the skill
if [ -L "$SKILLS_DIR/social-post" ]; then
    rm "$SKILLS_DIR/social-post"
fi

ln -s "$REPO_DIR/skills/social-post" "$SKILLS_DIR/social-post"
echo "Linked skill: social-post -> $SKILLS_DIR/social-post"

# Create .env from example if it doesn't exist
if [ ! -f "$REPO_DIR/.env" ]; then
    cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
    echo ""
    echo "Created .env file. Edit it with your API credentials:"
    echo "  $REPO_DIR/.env"
fi

echo ""
echo "Done! Use /social-post in Claude Code to post to social media."
echo ""
echo "Setup credentials for the platforms you want to use:"
echo "  Twitter/X:  https://developer.x.com/en/portal/dashboard"
echo "  Reddit:     https://www.reddit.com/prefs/apps"
echo "  Facebook:   https://developers.facebook.com/tools/explorer/"
echo "  Instagram:  (requires Business account linked to Facebook Page)"
