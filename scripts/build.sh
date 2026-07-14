#!/usr/bin/env bash
# Cross-compile nbusd + nbus to standalone binaries via `bun build --compile`.
#
# Produces, under dist/, one pair per target plus a SHA256SUMS manifest:
#   nbusd-<os>-<arch>   nbus-<os>-<arch>   SHA256SUMS
# where <os> is darwin|linux and <arch> is arm64|x64. These exact names are the
# contract consumed by install.sh, the Homebrew formula, and the release CI.
#
# Usage:
#   scripts/build.sh                # all targets
#   scripts/build.sh host           # only the current machine's target
#   VERSION=1.2.3 scripts/build.sh  # override version (default: package.json)
set -euo pipefail

cd "$(dirname "$0")/.."

DAEMON_ENTRY="src/daemon.ts"
CLI_ENTRY="src/cli.ts"
OUT_DIR="dist"

# Version: explicit env wins, else package.json, else git describe, else 0.0.0.
if [ -z "${VERSION:-}" ]; then
  VERSION="$(bun --print "require('./package.json').version" 2>/dev/null || true)"
fi
if [ -z "${VERSION:-}" ]; then
  VERSION="$(git describe --tags --always 2>/dev/null || echo 0.0.0)"
fi

# Map a Bun target triple → our <os>-<arch> suffix.
# Bun targets: bun-<os>-<arch>[-variant]. We ship the baseline builds.
TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-linux-x64:linux-x64"
)

host_suffix() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    *) echo "unsupported host OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64)  arch=x64 ;;
    *) echo "unsupported host arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

# Restrict to the host target when invoked as `build.sh host`.
if [ "${1:-}" = "host" ]; then
  hs="$(host_suffix)"
  filtered=()
  for entry in "${TARGETS[@]}"; do
    [ "${entry##*:}" = "$hs" ] && filtered=("$entry")
  done
  TARGETS=("${filtered[@]}")
fi

mkdir -p "$OUT_DIR"

build_one() {
  local entry="$1" out="$2" target="$3"
  echo "  building $out ($target)"
  bun build "$entry" --compile --target="$target" --outfile "$out" >/dev/null
}

echo "nbus build v${VERSION}"
for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  suffix="${entry##*:}"
  build_one "$DAEMON_ENTRY" "$OUT_DIR/nbusd-$suffix" "$target"
  build_one "$CLI_ENTRY"    "$OUT_DIR/nbus-$suffix"  "$target"

  # Per-platform tarball bundling both binaries under their bare names
  # (nbusd, nbus) — this is what the Homebrew formula installs (one url/sha
  # per platform). Staged in a temp dir so the archive members are unsuffixed.
  stage="$(mktemp -d)"
  cp "$OUT_DIR/nbusd-$suffix" "$stage/nbusd"
  cp "$OUT_DIR/nbus-$suffix"  "$stage/nbus"
  chmod +x "$stage/nbusd" "$stage/nbus"
  tar -czf "$OUT_DIR/nbus-$suffix.tar.gz" -C "$stage" nbusd nbus
  rm -rf "$stage"
done

# Ship the service installer alongside the binaries so `install.sh` can drop it
# in too (it's self-contained — embedded unit/plist, no sibling deps).
cp packaging/nbus-service "$OUT_DIR/nbus-service"

# Checksums over every artifact. The `nbus-*` glob already covers the CLI
# binaries, the tarballs (nbus-*.tar.gz), AND nbus-service — so only two globs.
# (portable: shasum on macOS, sha256sum on Linux).
echo "generating SHA256SUMS"
cd "$OUT_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum nbusd-* nbus-* > SHA256SUMS
else
  shasum -a 256 nbusd-* nbus-* > SHA256SUMS
fi
cd - >/dev/null

echo "done -> $OUT_DIR/"
ls "$OUT_DIR"
