#!/usr/bin/env bash
# One-time setup: Bun, deps, a `social` on PATH, and the skills linked into Claude Code.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo "Install Bun first: curl -fsSL https://bun.sh/install | bash"; exit 1; }
bun install
bun link            # puts `social` on PATH (bun's global bin dir)
# Fetch the API specs and generate from them. Lenient: drift from a pin is reported, not fatal,
# and one unreachable spec doesn't stop setup (rerun `social specs pull` later).
bun run src/cli.ts specs pull || echo "Some specs could not be pulled; rerun: social specs pull"
bun run gen-skills  # SKILL.md per platform, from the CLI
mkdir -p ~/.claude/skills
for d in skills/social-*; do ln -sfn "$PWD/$d" ~/.claude/skills/"$(basename "$d")"; done
echo "Linked $(ls -d skills/social-* | wc -l | tr -d ' ') skills into ~/.claude/skills."
echo "Next: social auth status, then social auth set <platform> <KEY> <value> or social auth login <platform>."
