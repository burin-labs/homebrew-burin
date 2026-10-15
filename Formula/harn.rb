class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.166"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "89f916158f2c0c57467f6a3c85e18819b9879ae3685e6f066f67748ada29c547"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "84299f191bb8c4c720820ab43c2dbbca6644c304db2508ba73f2b84f3d3df3c1"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "ae4b1747125fd045f02ac9ccc123dc6394d8952a722d817a54bebfaf43abc862"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "7fead9d9e11ca018da6d465dc73cf3e059cd2a76b6559787953ea6c38dc0540c"
    end
  end

  def install
    notices = buildpath/"THIRD-PARTY-NOTICES.txt"
    if !notices.file? || notices.symlink? || notices.empty?
      odie "Harn archive must contain nonempty regular THIRD-PARTY-NOTICES.txt"
    end
    bin.install "harn"
    pkgshare.install notices
  end

  def caveats
    <<~EOS
      Harn is pre-release software and is not yet supported.

      Expect breaking changes between releases, including to the command line
      interface and to on-disk formats. There is no compatibility guarantee
      between any two versions, and no support channel.

      Releases move quickly. Run `brew upgrade harn` often; an install left
      alone for a few days is likely to be several releases behind.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/harn --version")
    assert_match "serve", shell_output("#{bin}/harn --help")
  end
end
