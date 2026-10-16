#!/usr/bin/env bash
#
# Start disposable Bludit Community and Pro installations and collect their API
# credentials, so the live compatibility tests have something real to talk to.
#
# What this gives you that the mock cannot: a real `bl-plugins/api` running on a
# real PHP, with real `.htaccess` routing, real page storage and real JSON
# responses. It is what turns the compatibility matrix from "mock-verified" into
# "live-verified".
#
# Requirements: Docker. Nothing else.
#
# Usage:
#   scripts/live-bludit-up.sh              # both editions
#   scripts/live-bludit-up.sh community    # one edition
#   scripts/live-bludit-up.sh --down       # stop and remove the containers
#
# Writes reports/live-bludit-credentials.json (git-ignored) and prints it.
# Credentials are for throwaway containers on loopback and are never committed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/.live-bludit"
OUT="$ROOT/reports/live-bludit-credentials.json"
DOCKERFILE="$ROOT/tools/live-bludit/Dockerfile"

COMMUNITY_URL="https://codeload.github.com/bludit/bludit/tar.gz/refs/tags/3.22.0"
COMMUNITY_PORT=8801
PRO_PORT=8802

log() { printf '%s\n' "$*" >&2; }

down() {
  for name in bludit-live-community bludit-live-pro; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  log "containers removed"
}

# Wait until Apache answers at all; the image needs a moment after `run`.
wait_for_http() {
  local url=$1
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  log "timed out waiting for $url"
  return 1
}

stage_source() {
  local edition=$1
  local dir="$WORK/source-$edition"
  if [ -d "$dir" ] && [ -f "$dir/index.php" ]; then
    log "reusing staged $edition source at $dir"
    return 0
  fi
  mkdir -p "$dir"
  case "$edition" in
    community)
      log "downloading Bludit Community 3.22.0"
      curl -fsSL --max-time 300 -o "$WORK/community.tar.gz" "$COMMUNITY_URL"
      tar -xzf "$WORK/community.tar.gz" -C "$dir" --strip-components=1
      ;;
    pro)
      # Bludit Pro is not publicly downloadable. Point PRO_ZIP at the release
      # archive to test it; the live Pro tests are skipped otherwise.
      if [ -z "${PRO_ZIP:-}" ] || [ ! -f "${PRO_ZIP:-}" ]; then
        log "PRO_ZIP is not set to an existing archive; skipping Pro"
        return 1
      fi
      log "extracting Bludit Pro from $PRO_ZIP"
      local tmp="$WORK/pro-extract"
      rm -rf "$tmp" && mkdir -p "$tmp"
      unzip -q "$PRO_ZIP" -d "$tmp"
      local inner
      inner=$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -1)
      cp -a "$inner/." "$dir/"
      ;;
    *) log "unknown edition $edition"; return 1 ;;
  esac
  rm -rf "$dir/.github"
  log "staged $edition at $dir"
}


start_edition() {
  local edition=$1 port=$2
  local name="bludit-live-$edition"
  local dir="$WORK/source-$edition"

  stage_source "$edition" || return 1

  # The Dockerfile copies `site-<edition>/` relative to its build context, so
  # build from a context that has that layout.
  local ctx="$WORK/context-$edition"
  rm -rf "$ctx" && mkdir -p "$ctx"
  cp -a "$dir" "$ctx/site-$edition"
  docker build --build-arg "SITE_DIR=site-$edition" -t "bludit-live:$edition" -f "$DOCKERFILE" "$ctx" >/dev/null

  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "$port:80" "bludit-live:$edition" >/dev/null

  log "waiting for $edition on port $port"
  wait_for_http "http://127.0.0.1:$port/install.php"
}

install_and_collect() {
  local edition=$1 port=$2
  local base="http://127.0.0.1:$port"
  local jar
  jar="$(mktemp)"

  log "installing $edition (demo installer: admin / demo123)"
  curl -fsSL --max-time 60 -o /dev/null "$base/install.php?demo=true"

  # Sign in and ask Bludit for the API credentials. The admin "api" controller
  # activates the API plugin and returns its token plus the admin's auth token.
  curl -fsS -c "$jar" -b "$jar" --max-time 30 "$base/admin/login?enableAPI" -o "$jar.login.html"
  local csrf
  csrf="$(sed -n 's/.*name="tokenCSRF" value="\([^"]*\)".*/\1/p' "$jar.login.html" | head -1)"
  if [ -z "$csrf" ]; then
    log "could not find a CSRF token on the login page for $edition"
    rm -f "$jar" "$jar.login.html"
    return 1
  fi
  curl -fsS -c "$jar" -b "$jar" --max-time 30 -o /dev/null \
    -d "tokenCSRF=$csrf&username=admin&password=demo123" \
    "$base/admin/login?enableAPI" || true
  curl -fsS -c "$jar" -b "$jar" --max-time 30 "$base/admin/api" -o "$jar.api.json"
  rm -f "$jar" "$jar.login.html"

  node -e '
    const fs = require("fs");
    const [file, edition, base, out] = process.argv.slice(1);
    const api = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!api.apiToken || !api.authToken) throw new Error("credentials missing from /admin/api");
    const existing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { sites: [] };
    existing.sites = existing.sites.filter((s) => s.edition !== edition);
    existing.sites.push({
      edition,
      baseUrl: base,
      apiToken: api.apiToken,
      authToken: api.authToken,
      bluditVersion: "3.22.0",
      obtainedAt: new Date().toISOString()
    });
    existing.generatedAt = new Date().toISOString();
    fs.writeFileSync(out, JSON.stringify(existing, null, 2) + "\n");
  ' "$jar.api.json" "$edition" "$base" "$OUT"
}

main() {
  mkdir -p "$WORK" "$ROOT/reports"

  if [ "${1:-}" = "--down" ]; then down; return 0; fi

  local which="${1:-both}"
  case "$which" in
    community) start_edition community "$COMMUNITY_PORT" && install_and_collect community "$COMMUNITY_PORT" ;;
    pro) start_edition pro "$PRO_PORT" && install_and_collect pro "$PRO_PORT" ;;
    both)
      start_edition community "$COMMUNITY_PORT" && install_and_collect community "$COMMUNITY_PORT"
      start_edition pro "$PRO_PORT" && install_and_collect pro "$PRO_PORT" || log "Pro not available; continuing with Community only"
      ;;
    *) log "usage: $0 [community|pro|both|--down]"; exit 2 ;;
  esac

  log ""
  log "credentials written to $OUT"
  cat "$OUT"
  log ""
  log "run the live tests with:  npm run test:live"
}

main "$@"
