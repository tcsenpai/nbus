# Homebrew formula for nbus (local IPC bus): the nbusd daemon + nbus CLI.
#
# Distribution model: PREBUILT BINARIES packaged as per-platform tarballs.
#
# `scripts/build.sh` currently emits BARE binaries (nbusd-<os>-<arch>,
# nbus-<os>-<arch>) plus a SHA256SUMS manifest. Homebrew, however, models one
# `url` (one downloadable resource) per platform. Bundling both binaries into a
# single tarball per platform is the clean, idiomatic fit: one url + one sha256
# per (os, arch), and `bin.install "nbusd", "nbus"` unpacks both.
#
# DEPENDENCY (must be wired before this formula resolves at release time):
#   scripts/build.sh and the release CI must ALSO produce, per target:
#     nbus-<os>-<arch>.tar.gz   containing the two files `nbusd` and `nbus`
#     (unsuffixed names inside the tarball, so bin.install finds them).
#   The SHA256SUMS manifest should include these tarballs so the sha256 values
#   below can be filled from it.
#
# PLACEHOLDERS: every REPLACE_WITH_SHA256_<platform> below is a stand-in — no
# release exists yet. At release time, read the tarball checksums out of the
# release's SHA256SUMS and substitute them (see packaging/homebrew/README.md).
class Nbus < Formula
  desc "Local IPC bus: nbusd daemon and nbus CLI"
  homepage "https://github.com/tcsenpai/nbus"
  version "0.0.0" # bumped per release to match the git tag (vX.Y.Z)
  license "MIT"

  # URL/sha resolved per platform below. Base pattern:
  #   https://github.com/tcsenpai/nbus/releases/download/v<version>/nbus-<os>-<arch>.tar.gz
  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/tcsenpai/nbus/releases/download/v#{version}/nbus-darwin-arm64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_darwin_arm64"
    end
    if Hardware::CPU.intel?
      url "https://github.com/tcsenpai/nbus/releases/download/v#{version}/nbus-darwin-x64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_darwin_x64"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/tcsenpai/nbus/releases/download/v#{version}/nbus-linux-arm64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_linux_arm64"
    end
    if Hardware::CPU.intel?
      url "https://github.com/tcsenpai/nbus/releases/download/v#{version}/nbus-linux-x64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_linux_x64"
    end
  end

  def install
    # Tarball contains the two unsuffixed binaries; brew sets the exec bit.
    bin.install "nbusd", "nbus"
  end

  # `brew services start nbus` wraps this via launchd (macOS) / systemd (Linux).
  service do
    run [opt_bin/"nbusd"]
    keep_alive true
    log_path var/"log/nbus/nbusd.log"
    error_log_path var/"log/nbus/nbusd.err.log"
  end

  test do
    # Exit 0 on --help is enough to prove the binary runs on this platform.
    assert_path_exists bin/"nbus"
    system bin/"nbus", "--help"
  end
end
