cask "burin-code" do
  version "0.1.3"
  sha256 "14f52486a8dfbb1ee5bff599c95ae2f6f71f5b505875df5b60424207f59eca11"

  url "https://github.com/burin-labs/burin-code/releases/download/v#{version}/Burin.Code.dmg"
  name "Burin Code"
  desc "AI-native coding workbench"
  homepage "https://burincode.com/"

  depends_on macos: :sonoma

  app "Burin Code.app"

  zap trash: [
    "~/Library/Application Support/Burin Code",
    "~/Library/Caches/com.burinlabs.BurinCode",
    "~/Library/Preferences/com.burinlabs.BurinCode.plist",
    "~/Library/Saved Application State/com.burinlabs.BurinCode.savedState",
  ]
end
