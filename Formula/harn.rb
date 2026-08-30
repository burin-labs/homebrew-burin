class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.123"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "79eecc4ba0a502cd95f07e6e35a5586bc257d6e66f2cad5d66dcafdce71ca15d"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "2f98e29231e3c8c3d6e3afc5c4fd9c2a741e45b1136678a080f277049632f2e9"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "7815e3b4f8ec1c965121c9e11f4e60495e5d8192cb6abc86e544a1b2e9084181"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "94e8c653d1de5c5b4ce4cf912e6d58e99fbfc3d9b1cc3228a72603d780fe3288"
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
