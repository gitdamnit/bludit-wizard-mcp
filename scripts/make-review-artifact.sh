#!/usr/bin/env bash
#
# Build a security-review artifact: a Git bundle and a source ZIP.
#
# Both are produced from `git archive`, so only tracked files are included. That
# is the strongest available guarantee that no dependency directory, no local
# environment file and no local database ends up in the artifact: none of them is
# tracked, and `.gitignore` already covers them.
#
# Reports are added back deliberately, because a reviewer needs the measured
# results. The one report that is *not* included is the live credential file: it
# holds throwaway API tokens, and a generated credential does not belong in a
# distributable archive even when it is for a container that no longer exists.
#
# Usage:  scripts/make-review-artifact.sh
# Output: review-artifacts/ (git-ignored)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse --short HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="$ROOT/review-artifacts"
NAME="bludit-wizard-mcp-review-$SHA"

mkdir -p "$OUT"
rm -rf "$OUT/$NAME" "$OUT/$NAME.zip" "$OUT/$NAME.bundle"

echo "==> Git bundle (full history from $SHA)"
# `HEAD` includes every commit reachable from it, so the upstream history the
# derivative is based on travels with the bundle and attribution is verifiable
# offline with `git log`.
git bundle create "$OUT/$NAME.bundle" HEAD >/dev/null
git bundle verify "$OUT/$NAME.bundle" >/dev/null

echo "==> Source tree (tracked files only)"
STAGE="$OUT/$NAME"
mkdir -p "$STAGE"
git archive HEAD | tar -x -C "$STAGE"

echo "==> Reports"
mkdir -p "$STAGE/reports"
for report in junit.xml playwright-junit.xml live-junit.xml \
              bludit-compatibility.json bludit-live-compatibility.json; do
  if [ -f "reports/$report" ]; then cp "reports/$report" "$STAGE/reports/"; fi
done
if [ -d reports/coverage ]; then
  cp -a reports/coverage "$STAGE/reports/coverage"
fi

echo "==> Review index"
cat > "$STAGE/REVIEW.md" <<EOF
# Bludit Wizard MCP — security review artifact

Generated: $STAMP
Commit: \`$FULL_SHA\` (short \`$SHA\`)
Branch: \`$BRANCH\`

## What this is

An independent, MIT-licensed derivative of \`bludit/bludit-mcp\`, pinned at
\`73b5ddcb92015d1359370ba2613090eef6af910c\`: a universal remote MCP server for
Bludit CMS, running on Cloudflare Workers with OAuth 2.1.

Start with \`docs/PROJECT_STATUS.md\`, then \`docs/SECURITY.md\` for the risk
register, \`docs/ARCHITECTURE.md\` for the topology and the cost model, and
\`docs/DECISION_LOG.md\` for why each choice was made.

## What is in here

| Path | Contents |
|---|---|
| \`src/\` | All application code (two Workers, shared libraries) |
| \`migrations/\` | D1 schema, additive only |
| \`test/\` | Unit, integration, compatibility, live and browser suites |
| \`wrangler.*.jsonc\` | Worker configuration: deployable, test, and production-shape |
| \`migrations/\`, \`scripts/\`, \`tools/\` | Schema, tooling, the live-Bludit Docker assets |
| \`openai-plugin/\` | Prepared (not submitted) plugin package |
| \`reports/\` | Measured test results: JUnit XML, compatibility JSON, coverage |
| \`docs/\` | The documentation set |
| \`*.bundle\` (sibling file) | Full Git history, verifiable offline |

## What is deliberately NOT in here

| Excluded | Why |
|---|---|
| \`node_modules/\`, and any dependency tree | Reproducible with \`npm ci\` from the committed lockfile |
| \`.wrangler/\`, \`dist/\` | Build output |
| \`.dev.vars\`, \`.env*\` | Local secrets; \`.dev.vars.example\` shows the variable names with empty values |
| \`reports/live-bludit-credentials.json\` | Generated API tokens for the throwaway live containers. Throwaway or not, a credential does not travel in an archive |
| \`.live-bludit/\` | Staged Bludit sources and Docker build contexts |
| Any D1 database file | None exists in the repository; schema is applied from \`migrations/\` |
| Any production credential | None exists in the repository, and a test asserts the deployable configs carry none |

The \`wrangler.*.test.jsonc\` and \`wrangler.*.prodshape.jsonc\` files do contain
fixed, clearly-labelled **test** keys. They are fixtures the hermetic suite needs
in order to run, they protect nothing, and each file says so in its own comment.
They are not production credentials and must never be copied into a deployment.

## Reproducing the results

\`\`\`bash
npm ci
npm run typecheck
npm test                     # 324 hermetic tests, no network or credentials
npm run test:browser         # 9 browser tests
npm run build:auth && npm run build:mcp

# Optional: real Bludit, needs Docker
PRO_ZIP=/path/to/bludit-pro-3.22.0.zip scripts/live-bludit-up.sh both
npm run test:live            # 24 live tests
scripts/live-bludit-up.sh --down
\`\`\`

## Verifying the Git bundle

\`\`\`bash
git clone bludit-wizard-mcp-review-$SHA.bundle review
cd review && git log --oneline | tail -20   # upstream history is intact
\`\`\`

## The claims worth checking first

1. **No secret in the repository.** \`test/unit/production-config.test.ts\`.
2. **Credentials are ciphertext at rest.** \`test/integration/security-controls.test.ts\`.
3. **Cross-account isolation.** Same file; 12 probes, all \`not_found\`.
4. **SSRF.** Same file, plus \`test/unit/ssrf.test.ts\`.
5. **Rate limiting.** \`test/integration/rate-limit.test.ts\`.
6. **Deletion is not exposed.** \`test/integration/mcp-tools.test.ts\`.
EOF

echo "==> Guard: nothing excluded leaked in"
fail=0

# Exact names, so `.dev.vars.example` (a template, intended to ship) does not
# trip the check for `.dev.vars` (a real local secret file).
for exact in .dev.vars .env .env.local live-bludit-credentials.json bludit.png; do
  if find "$STAGE" -name "$exact" -print -quit 2>/dev/null | grep -q .; then
    echo "ERROR: excluded file '$exact' is present in the staging tree" >&2
    fail=1
  fi
done

for dir in node_modules .wrangler .live-bludit .git dist build-context; do
  if find "$STAGE" -type d -name "$dir" -print -quit 2>/dev/null | grep -q .; then
    echo "ERROR: excluded directory '$dir' is present in the staging tree" >&2
    fail=1
  fi
done

# Any PEM block anywhere in the tree.
if grep -rIl --exclude-dir=.git -e 'BEGIN [A-Z ]*PRIVATE KEY' "$STAGE" 2>/dev/null | grep -q .; then
  echo "ERROR: private key material found in the staging tree" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "    no secret-bearing path or private key material detected"


echo "==> Zip"
( cd "$OUT" && zip -qr "$NAME.zip" "$NAME" )
rm -rf "$STAGE"

echo
echo "Artifacts in $OUT"
ls -lh "$OUT/$NAME.bundle" "$OUT/$NAME.zip" | awk '{print "  " $9 " (" $5 ")"}'
echo
echo "Archive contents (top level):"
unzip -l "$OUT/$NAME.zip" | awk '{print $4}' | grep -E "^$NAME/[^/]*$" | sed 's/^/  /'
