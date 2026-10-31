class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.184"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "adb6633316790a7c69f74ae1d37c52c3ea6f3854b3b95154e53c957fdf3b7af8"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "af0833cf04bf72fb7362f7d44e70c4d8bbede9057b6e5699adfc16620071605d"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "fbf94c36d1db389972310dae9e199d12bb7ce97909e7218cd7f29314418f1a9d"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "8c9b9da510517e271dc949efaa5c1b6b8a21fc4bf51e81654cf381c9742efbf3"
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
