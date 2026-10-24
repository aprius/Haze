#!/bin/bash
# Installs the latest Haze release on macOS; Update Now in Haze keeps it current.
#   curl -fsSL https://raw.githubusercontent.com/aprius/Haze/main/install.sh | bash
# HAZE_INSTALL_DIR overrides the folder (default: /Applications, or ~/Applications
# when /Applications is not writable).
set -euo pipefail

REPO="aprius/Haze"
BUNDLE_ID="dev.haze.app"

fail() {
  echo "haze: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "this script is for macOS; download Haze from https://github.com/$REPO/releases"

if [ -d /opt/homebrew/Caskroom/haze ] || [ -d /usr/local/Caskroom/haze ]; then
  fail "Haze is installed with Homebrew; update it with 'haze update' or Update Now in Haze"
fi

if [ -n "${HAZE_INSTALL_DIR:-}" ]; then
  dest=$HAZE_INSTALL_DIR
elif [ -w /Applications ]; then
  dest=/Applications
else
  dest="$HOME/Applications"
fi
mkdir -p "$dest"

echo "==> Looking up the latest Haze release"
json=$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest")
# JavaScript for Automation ships with macOS, so no jq or python is needed.
read -r version url sha256 < <(osascript -l JavaScript -e '
  function run(argv) {
    const release = JSON.parse(argv[0]);
    const version = release.tag_name.replace(/^v/, "");
    const asset = release.assets.find((a) => a.name === `Haze_${version}_universal.dmg`);
    if (!asset) return "";
    return [version, asset.browser_download_url, (asset.digest || "").replace(/^sha256:/, "")].join(" ");
  }' "$json")
[ -n "${url:-}" ] || fail "the latest release has no macOS download"
[ -n "${sha256:-}" ] || fail "the latest release publishes no checksum"

tmp=$(mktemp -d)
mount="$tmp/mnt"
cleanup() {
  hdiutil detach -force -quiet "$mount" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

echo "==> Downloading Haze $version"
curl -fL --progress-bar -o "$tmp/Haze.dmg" "$url"
[ "$(shasum -a 256 "$tmp/Haze.dmg" | cut -d' ' -f1)" = "$sha256" ] || fail "the download is corrupt (checksum mismatch)"

echo "==> Installing to $dest/Haze.app"
mkdir -p "$mount"
hdiutil attach -nobrowse -readonly -noautoopen -quiet -mountpoint "$mount" "$tmp/Haze.dmg"
running=false
if [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null)" = "true" ]; then
  running=true
  # Terminals live in a separate PTY host and keep running.
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 20); do
    [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null)" = "true" ] || break
    sleep 0.5
  done
fi
rm -rf "$dest/Haze.app"
ditto "$mount/Haze.app" "$dest/Haze.app"
# The app is not notarized; without this Gatekeeper refuses to open it.
xattr -dr com.apple.quarantine "$dest/Haze.app" 2>/dev/null || true

echo "==> Haze $version is installed"
if [ "$running" = true ] || [ -z "${HAZE_INSTALL_DIR:-}" ]; then
  open "$dest/Haze.app"
fi
