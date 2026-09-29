class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.150"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "5adddc8363d3b3226e4b4ea2dd3255c23bcc5fad99a203470b6c9bbe576df794"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "2cafb0164424ce232e5cfc5f6ca6fbcee8247fba5a81211de1932cf4524bf0f1"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "d6065dee24c91d799a0de3a4e06cc2d9086add4ece306326881b315ce3e6cd09"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "27c9188828fbddfca4af61f6530565c7f461d08393a0a0167bf3b42b914b4525"
    end
  end

  def install
    bin.install "harn"
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
