class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.183"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "11343fc8718f8cf66eab7a77fd8ea2ce1acbe0c9550d61abe24064fc785dcd1c"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "3b0b5046d976112545df4990427e8aa336c1f11f7f5fb90a72600951b3f0430b"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "cce8d5b6eb2c49d4995ec67e99a30bdd9e95f8384033d826566c26a5a76277d8"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "ab1a27027edceac3762af7766753dcbe87f871fc2ba088443225e40568ff3c81"
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
