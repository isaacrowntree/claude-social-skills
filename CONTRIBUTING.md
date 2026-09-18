# Contributing

Thanks for looking. This is a small project with one rule that matters: the CLI must match what the platforms actually do, not what their docs say.

## Setup

```bash
./scripts/setup.sh
bun run check      # verify-gen, gen-skills --verify, tsc, bun test
```

## Adding a command

1. Put it in the platform's `register()` in `src/platforms/<name>/index.ts`. Take `--json` and `--jq <e>`; give it a one-line human formatter. Do not add a flag per API field; that is what `social api <platform> <path>` is for.
2. Cite the doc page for each endpoint in a comment. If the live server disagrees with the docs, code to the server and say so in the comment.
3. Add a test in `tests/<name>.test.ts` against the local fake, asserting method, path, query, headers and body. No network in tests.
4. Run `bun run gen-skills` so the platform's `SKILL.md` picks it up; CI fails on drift.

## Adding a platform

Copy the shape of `src/platforms/x/index.ts`: a `Platform` object with `http()`, `register()`, `whoami()` and optionally `auth()`. If the platform publishes an OpenAPI or Discovery document, add it to `scripts/specs.ts` and run `bun run gen --update` to pin it. Register the module in `src/platforms/index.ts`.

## Before a pull request

- `bun run check` is green.
- You exercised whatever the credentials you have allow against the real server, read-only, and said in the PR what you could not run.
- Nothing in the diff is a token, an account id, an email address or a message id from your own account.
