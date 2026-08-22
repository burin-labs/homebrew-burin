class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.10.110"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "a0956fba6a44cfb834ad8ce2862a591ffe4df469315e38d280c051b1baae2f11"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "00c5a27576a5969d6c1d06e575eb708a6f0024f46d2af7b53ad77bacbecb146e"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "56db458a0abd8ef39d6b5b530c44afc0b5754f70e25a2c42b78ca0ab19fc494b"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "4e2877eef35ce978f71fd8bb72a67ace823c1974668cb2fc9f919c1d24b498dc"
    end
  end

  def install
    bin.install "harn"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/harn --version")
    assert_match "serve", shell_output("#{bin}/harn --help")
  end
end
