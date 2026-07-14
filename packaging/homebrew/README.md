# Homebrew distribution for nbus

Ships the prebuilt `nbusd` daemon and `nbus` CLI via a Homebrew tap.

## Install (end users)

```sh
brew tap tcsenpai/nbus
brew install nbus
```

`brew tap tcsenpai/nbus` resolves to the GitHub repo `tcsenpai/homebrew-nbus`
(Homebrew strips the `homebrew-` prefix). To run the daemon under Homebrew's
service manager:

```sh
brew services start nbus     # launchd on macOS, systemd on Linux
brew services stop nbus
```

Logs land under `$(brew --prefix)/var/log/nbus/`.

## Setting up the tap repo (maintainer, one-time)

The formula in this directory lives in a *separate* tap repository. This repo
(`tcsenpai/nbus`) holds the source of truth under `packaging/homebrew/`; the tap
repo holds the published copy Homebrew fetches.

1. Create a public GitHub repo named **`tcsenpai/homebrew-nbus`** (the
   `homebrew-` prefix is required by Homebrew's tap convention).
2. Add `Formula/nbus.rb` to it, copied from `packaging/homebrew/nbus.rb`.
3. That's it — `brew tap tcsenpai/nbus` then finds `Formula/nbus.rb`.

This repo does not create the tap repo; do it manually or via CI.

## Distribution model: per-platform tarballs

The formula is written against **per-platform tarballs**, not the bare binaries.

Homebrew models one downloadable `url` (one resource) per platform. The cleanest
correct fit is a single tarball per `(os, arch)` bundling both binaries:

```
nbus-<os>-<arch>.tar.gz   # contains unsuffixed `nbusd` and `nbus`
```

`bin.install "nbusd", "nbus"` then unpacks both from one download.

### Build/CI dependency (must be wired)

`scripts/build.sh` currently emits **bare** binaries:

```
nbusd-<os>-<arch>   nbus-<os>-<arch>   SHA256SUMS
```

For this formula to resolve, the build + release pipeline must **additionally**
produce, per target, a tarball whose members are the *unsuffixed* names:

```
nbus-<os>-<arch>.tar.gz  ->  nbusd, nbus
```

and include those tarballs in `SHA256SUMS`. Sketch for `build.sh` (after the
per-target build loop, inside `dist/`):

```sh
for suffix in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  # stage unsuffixed names so the tarball unpacks to bin/nbusd, bin/nbus
  cp "nbusd-$suffix" nbusd
  cp "nbus-$suffix"  nbus
  tar -czf "nbus-$suffix.tar.gz" nbusd nbus
  rm -f nbusd nbus
done
# then checksum the tarballs too:
shasum -a 256 nbus-*.tar.gz >> SHA256SUMS   # sha256sum on Linux
```

The release workflow (`release.yml`) must upload these `*.tar.gz` assets
alongside the bare binaries. Flagged as an external dependency — not wired here.

## Bumping version + checksums on each release

Per release `vX.Y.Z`:

1. Set `version "X.Y.Z"` in the formula (matches the git tag, drop the `v`).
2. Replace each `REPLACE_WITH_SHA256_<platform>` with the tarball's real sha256,
   read from the release's `SHA256SUMS`. For example:

   ```sh
   grep 'nbus-darwin-arm64.tar.gz' SHA256SUMS | awk '{print $1}'
   ```

3. Copy the updated `nbus.rb` into `tcsenpai/homebrew-nbus` at `Formula/nbus.rb`
   and push.

This is mechanical and should be automated later (a release-job step that
templates the version + all four sha256 values and opens a PR against the tap
repo). Until then it is a manual edit.

## Verifying the formula locally

```sh
ruby -c packaging/homebrew/nbus.rb          # Ruby syntax check
brew style packaging/homebrew/nbus.rb       # style lint (see note below)
```

`brew style` / `brew audit` will complain about the placeholder sha256 strings
(they are not valid 64-hex digests) until a real release fills them in. That is
expected pre-release.
