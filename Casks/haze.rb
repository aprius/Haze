# Homebrew cask cho Haze. Tự cập nhật version/sha256 bởi .github/workflows/release.yml.
#   brew tap aprius/haze https://github.com/aprius/Haze
#   brew install --cask haze
cask "haze" do
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/aprius/Haze/releases/download/v#{version}/Haze_#{version}_universal.dmg"
  name "Haze"
  desc "Lightweight AI-first workspace with Rider-style project view and Git tooling"
  homepage "https://github.com/aprius/Haze"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :catalina"

  app "Haze.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Haze.app"],
                   sudo: false
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
