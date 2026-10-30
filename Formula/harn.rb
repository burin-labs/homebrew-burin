class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.182"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "6324efdd7f7bded86ac63e96a2216fa046aeb25b32d8a944f44424640c5c95b6"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "300dc6c24108bbd40e1bfcccfb4ece29ccd19dff794ba19722fc13b751e52aaf"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "0c22ee0a9909ab1578f6167298c54945399c9b03d126deae3062bf6ad96b19a1"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "9e97ba2a0755142421398e5dc3e6243f367f7f4986f1d3d9dd7b760724130e88"
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
