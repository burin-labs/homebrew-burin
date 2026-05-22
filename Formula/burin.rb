class Burin < Formula
  desc "AI-native terminal coding workbench"
  homepage "https://burincode.com/"
  license "Apache-2.0"
  head "https://github.com/burin-labs/burin-code.git", branch: "main"

  depends_on "node@22"

  def install
    node = Formula["node@22"]
    cli_version = build.head? ? "0.2.0-head" : version.to_s
    ENV["npm_config_audit"] = "false"
    ENV["npm_config_fund"] = "false"
    ENV["npm_config_update_notifier"] = "false"
    system node.opt_bin/"npm", "ci", "--prefix", "tui"
    system node.opt_bin/"npm", "run", "--prefix", "tui", "build"
    system node.opt_bin/"node", "npm/cli/tools/build.mjs", "--version", cli_version
    system node.opt_bin/"npm", "install", "--global", "--prefix", libexec, buildpath/"npm/cli"
    bin.install_symlink libexec/"bin/burin"
  end

  test do
    assert_match "burin", shell_output("#{bin}/burin --version")
  end
end
