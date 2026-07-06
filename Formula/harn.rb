class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "0.9.17"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-apple-darwin.tar.gz"
      sha256 "8785839ee3d49e3ad0abf34e87b8c4c8346c0888c0859926c64f6a189cd4777f"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-apple-darwin.tar.gz"
      sha256 "08c9d345373c9d85a8803231fa1f7d5255c6b633bb1436aedc823c8ca81e640a"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "cd089cd57873f0beca370550ecacf1535d0b653a26449077fb8cc5cd5e4e91f5"
    else
      url "https://github.com/burin-labs/harn/releases/download/v#{version}/harn-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "dc20c94f662f0c9baf94268a212733d1d46878b1bd3d690b4988107fd2897fc3"
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
