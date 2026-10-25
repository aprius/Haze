# Homebrew cask for Haze. version/sha256 are updated by .github/workflows/release.yml.
#   brew tap aprius/haze https://github.com/aprius/Haze
#   brew install --cask haze
#   haze update
cask "haze" do
  version "1.0.7"
  sha256 "2353149dcf6244d4780e2d6a759327603383de73dd012bc71b2cc6ccdc67423a"

  url "https://github.com/aprius/Haze/releases/download/v#{version}/Haze_#{version}_universal.dmg"
  name "Haze"
  desc "Lightweight AI-first workspace with Rider-style project view and Git tooling"
  homepage "https://github.com/aprius/Haze"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on :macos

  app "Haze.app"
  binary "#{appdir}/Haze.app/Contents/Resources/haze"

  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Haze.app"]
  end

  zap trash: [
    "~/Library/Application Support/dev.haze.app",
    "~/Library/Caches/dev.haze.app",
    "~/Library/Logs/dev.haze.app",
    "~/Library/Preferences/dev.haze.app.plist",
    "~/Library/Saved Application State/dev.haze.app.savedState",
    "~/Library/WebKit/dev.haze.app",
  ]
end
