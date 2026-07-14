#!/bin/sh
# nbus installer — fetches the nbusd + nbus release binaries, verifies their
# sha256 sums, and installs them to a bin directory on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/tcsenpai/nbus/main/install.sh | sh
#
# Environment overrides:
#   NBUS_VERSION=v1.2.3   pin a specific release tag (default: latest)
#   PREFIX=/custom/bin    install directory (default: /usr/local/bin,
#                         falling back to ~/.local/bin when not writable)
#
# POSIX sh only: no bashisms (no arrays, no [[ ]]).
set -eu

REPO="tcsenpai/nbus"
GH_API="https://api.github.com/repos/${REPO}/releases/latest"
GH_DL="https://github.com/${REPO}/releases/download"

# ---- output helpers --------------------------------------------------------
info() { printf '%s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
err()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---- 1. detect OS ----------------------------------------------------------
detect_os() {
  os_raw="$(uname -s)"
  case "$os_raw" in
    Darwin) echo darwin ;;
    Linux)  echo linux ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      err "Windows is not supported. nbus ships darwin and linux binaries only." ;;
    *) err "unsupported OS: ${os_raw} (supported: Darwin, Linux)" ;;
  esac
}

# ---- 2. detect arch --------------------------------------------------------
detect_arch() {
  arch_raw="$(uname -m)"
  case "$arch_raw" in
    arm64|aarch64) echo arm64 ;;
    x86_64|amd64)  echo x64 ;;
    *) err "unsupported architecture: ${arch_raw} (supported: arm64, x64)" ;;
  esac
}

# ---- downloader abstraction (curl or wget) ---------------------------------
# DL_TOOL is set to "curl" or "wget" at startup.
detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    echo curl
  elif command -v wget >/dev/null 2>&1; then
    echo wget
  else
    err "neither curl nor wget found; install one and retry."
  fi
}

# fetch <url> <dest-file>  — download url to a file, fail on http errors.
fetch() {
  _url="$1"; _dest="$2"
  if [ "$DL_TOOL" = "curl" ]; then
    curl -fsSL "$_url" -o "$_dest"
  else
    wget -q -O "$_dest" "$_url"
  fi
}

# fetch_stdout <url>  — download url to stdout (used for the API call).
fetch_stdout() {
  _url="$1"
  if [ "$DL_TOOL" = "curl" ]; then
    curl -fsSL "$_url"
  else
    wget -q -O - "$_url"
  fi
}

# ---- 3. resolve version ----------------------------------------------------
resolve_version() {
  if [ -n "${NBUS_VERSION:-}" ]; then
    echo "$NBUS_VERSION"
    return
  fi
  # Ask the GitHub API for the latest release tag. The response is JSON; we
  # extract "tag_name": "vX.Y.Z" without a JSON parser (POSIX-portable).
  _json="$(fetch_stdout "$GH_API" 2>/dev/null || true)"
  if [ -z "$_json" ]; then
    err "could not reach the GitHub API to find the latest release. Set NBUS_VERSION=vX.Y.Z to pin one."
  fi
  _tag="$(printf '%s\n' "$_json" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"
  if [ -z "$_tag" ]; then
    # No tag field: most likely "Not Found" (no releases published yet).
    if printf '%s' "$_json" | grep -q '"message"[[:space:]]*:[[:space:]]*"Not Found"'; then
      err "no releases published for ${REPO} yet. Once a release exists, re-run; or set NBUS_VERSION to a tag."
    fi
    err "could not parse a release tag from the GitHub API response. Set NBUS_VERSION=vX.Y.Z to pin one."
  fi
  echo "$_tag"
}

# ---- sha256 tooling --------------------------------------------------------
# Echoes a function-like command name to compute a sha256 of a file to stdout.
sha256_of() {
  _file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$_file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$_file" | awk '{print $1}'
  else
    err "no sha256 tool found (need sha256sum or shasum); cannot verify download."
  fi
}

# Look up the expected sum for <filename> in the SHA256SUMS file.
# Format per line: "<64-hex-sha>␠␠<filename>" (two spaces, shasum style).
expected_sum() {
  _sums_file="$1"; _name="$2"
  # Match on the trailing filename exactly. Print only the hash field.
  awk -v want="$_name" '
    { fn = $2; sub(/^\*/, "", fn); if (fn == want) { print $1; exit } }
  ' "$_sums_file"
}

verify_file() {
  _sums_file="$1"; _file="$2"; _name="$3"
  _want="$(expected_sum "$_sums_file" "$_name")"
  if [ -z "$_want" ]; then
    err "SHA256SUMS has no entry for ${_name}; refusing to install unverified binary."
  fi
  _got="$(sha256_of "$_file")"
  if [ "$_want" != "$_got" ]; then
    info "  expected: $_want"
    info "  actual:   $_got"
    err "checksum mismatch for ${_name}; refusing to install (possible tampering or corrupt download)."
  fi
  info "  verified ${_name}"
}

# ---- 6. install directory resolution ---------------------------------------
resolve_prefix() {
  if [ -n "${PREFIX:-}" ]; then
    echo "$PREFIX"
    return
  fi
  _default="/usr/local/bin"
  # Writable if the dir exists and is writable, or (if missing) its parent is.
  if { [ -d "$_default" ] && [ -w "$_default" ]; } \
     || { [ ! -d "$_default" ] && [ -w "$(dirname "$_default")" ]; }; then
    echo "$_default"
  else
    echo "${HOME}/.local/bin"
  fi
}

# Warn if <dir> is not present in PATH.
warn_if_not_on_path() {
  _dir="$1"
  case ":${PATH}:" in
    *":${_dir}:"*) : ;;
    *) warn "${_dir} is not on your PATH. Add this to your shell profile:"
       info "  export PATH=\"${_dir}:\$PATH\"" ;;
  esac
}

# ---- main ------------------------------------------------------------------
main() {
  DL_TOOL="$(detect_downloader)"

  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  info "nbus installer — detected ${OS}-${ARCH}"

  TAG="$(resolve_version)"
  info "installing release: ${TAG}"

  DAEMON_ASSET="nbusd-${OS}-${ARCH}"
  CLI_ASSET="nbus-${OS}-${ARCH}"
  BASE="${GH_DL}/${TAG}"

  # 4. download into a temp dir with trap cleanup.
  TMP="$(mktemp -d 2>/dev/null || mktemp -d -t nbus)"
  trap 'rm -rf "$TMP"' EXIT INT HUP TERM

  info "downloading binaries and checksums..."
  fetch "${BASE}/${DAEMON_ASSET}" "${TMP}/${DAEMON_ASSET}" \
    || err "failed to download ${DAEMON_ASSET} from release ${TAG}."
  fetch "${BASE}/${CLI_ASSET}" "${TMP}/${CLI_ASSET}" \
    || err "failed to download ${CLI_ASSET} from release ${TAG}."
  fetch "${BASE}/SHA256SUMS" "${TMP}/SHA256SUMS" \
    || err "failed to download SHA256SUMS from release ${TAG}."

  # 5. verify sha256 (security-critical) BEFORE installing anything.
  info "verifying checksums..."
  verify_file "${TMP}/SHA256SUMS" "${TMP}/${DAEMON_ASSET}" "$DAEMON_ASSET"
  verify_file "${TMP}/SHA256SUMS" "${TMP}/${CLI_ASSET}"    "$CLI_ASSET"

  # 6. install (idempotent: install -m overwrites in place).
  DEST="$(resolve_prefix)"
  info "installing to ${DEST}..."
  mkdir -p "$DEST" || err "could not create install directory ${DEST}."
  if [ ! -w "$DEST" ]; then
    err "install directory ${DEST} is not writable. Re-run with sudo, or set PREFIX=~/.local/bin."
  fi

  chmod +x "${TMP}/${DAEMON_ASSET}" "${TMP}/${CLI_ASSET}"
  # Install stripping the -<os>-<arch> suffix: nbusd, nbus.
  cp "${TMP}/${DAEMON_ASSET}" "${DEST}/nbusd"
  cp "${TMP}/${CLI_ASSET}"    "${DEST}/nbus"
  chmod +x "${DEST}/nbusd" "${DEST}/nbus"

  # Best-effort: the service installer (systemd/launchd). Optional — older
  # releases may not ship it, so a missing asset is not fatal. When present it
  # is verified against SHA256SUMS like everything else before install.
  if fetch "${BASE}/nbus-service" "${TMP}/nbus-service" 2>/dev/null; then
    verify_file "${TMP}/SHA256SUMS" "${TMP}/nbus-service" "nbus-service"
    cp "${TMP}/nbus-service" "${DEST}/nbus-service"
    chmod +x "${DEST}/nbus-service"
    HAVE_SERVICE=1
  else
    HAVE_SERVICE=0
  fi

  warn_if_not_on_path "$DEST"

  # 7. summary + next steps.
  info ""
  info "nbus ${TAG} installed:"
  info "  ${DEST}/nbusd  (daemon)"
  info "  ${DEST}/nbus   (client)"
  [ "$HAVE_SERVICE" = 1 ] && info "  ${DEST}/nbus-service   (service installer)"
  info ""
  info "next steps:"
  info "  1. start the daemon:   nbusd &"
  info "  2. try the client:     nbus --help"
  if [ "$HAVE_SERVICE" = 1 ]; then
    info "  3. run as a service:   nbus-service install (systemd/launchd)"
  else
    info "  3. run as a service:   see the wiki (systemd/launchd)"
  fi
  info "     https://github.com/tcsenpai/nbus/wiki/Installation#running-as-a-service"
}

main "$@"
