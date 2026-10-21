#!/usr/bin/env bash
# Sets the version in package.json, tauri.conf.json, Cargo.toml (and Cargo.lock).
#   scripts/bump-version.sh 0.2.0
#   git commit -am "Release v0.2.0" && git tag v0.2.0 && git push --follow-tags
set -euo pipefail
version="${1:?usage: $0 <version>}"
cd "$(dirname "$0")/.."

npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
node -e '
  const fs = require("fs"), v = process.argv[1];
  const conf = "src-tauri/tauri.conf.json";
  const c = JSON.parse(fs.readFileSync(conf, "utf8"));
  c.version = v;
  fs.writeFileSync(conf, JSON.stringify(c, null, 2) + "\n");
  const toml = "src-tauri/Cargo.toml";
  fs.writeFileSync(toml, fs.readFileSync(toml, "utf8").replace(/^version = ".*"/m, `version = "${v}"`));
' "$version"
# Cargo writes the haze package's new version into Cargo.lock.
(cd src-tauri && { cargo metadata --format-version 1 --offline >/dev/null 2>&1 || cargo metadata --quiet --format-version 1 >/dev/null; })

echo "Haze $version"
