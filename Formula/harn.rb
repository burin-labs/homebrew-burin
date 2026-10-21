class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.173"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "d6036ec45dd1900cf301b05d8922adad45de720672ba5d6816ccb7f4dca949fc"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "b8c21c711cddb312ae5ff35f81f83ef23d659a59e4849f89b00e7aa627942e3f"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "cc789f6ada1f3bc463831ffca484e18e71ee47845c7ee2814ccbcb91241af6c8"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "89284b093c52583266c4320dc4bad494df0f33bff1b33305f4d8cf58954ab02a"
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
