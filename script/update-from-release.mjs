#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export function updateFromReleaseManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf-8"))
  const version = requireString(manifest.version, "version")
  const minimumSystemVersion = requireString(
    manifest.minimumSystemVersion,
    "minimumSystemVersion",
  )
  const cliVersion = requireString(manifest.cliVersion ?? manifest.version, "cliVersion")
  const dmg = requireArtifact(manifest.artifacts?.["macos-arm64-dmg"], "macos-arm64-dmg")
  const cli = requireArtifact(manifest.artifacts?.["cli-npm-tarball"], "cli-npm-tarball")

  write("Casks/burin-code.rb", renderCask({ version, dmg, minimumSystemVersion }))
  write("Formula/burin.rb", renderFormula({ version: cliVersion, cli }))
  write("README.md", renderReadme({ appVersion: version, cliVersion }))
}

export function renderCask({ version, dmg, minimumSystemVersion }) {
  return `cask "burin-code" do
  version "${version}"
  sha256 "${dmg.sha256}"

  url "${dmg.url}",
      verified: "github.com/burin-labs/burin-code/"
  name "Burin Code"
  desc "AI-native coding workbench"
  homepage "https://burincode.com/"

  depends_on macos: :${macosSymbol(minimumSystemVersion)}

  app "Burin Code.app"

  zap trash: [
    "~/Library/Application Support/Burin Code",
    "~/Library/Caches/com.burinlabs.BurinCode",
    "~/Library/Preferences/com.burinlabs.BurinCode.plist",
    "~/Library/Saved Application State/com.burinlabs.BurinCode.savedState",
  ]
end
`
}

export function renderFormula({ version, cli }) {
  return `class Burin < Formula
  desc "AI-native terminal coding workbench"
  homepage "https://burincode.com/"
  url "${cli.url}"
  sha256 "${cli.sha256}"
  license "Apache-2.0"

  depends_on "node@22"

  def install
    node = Formula["node@22"]
    ENV["npm_config_audit"] = "false"
    ENV["npm_config_fund"] = "false"
    ENV["npm_config_update_notifier"] = "false"
    system node.opt_bin/"npm", "install", "--global", "--prefix", libexec, cached_download
    bin.install_symlink libexec/"bin/burin"
  end

  test do
    assert_match "burin", shell_output("#{bin}/burin --version")
  end
end
`
}

export function renderReadme({ appVersion, cliVersion }) {
  return `# Homebrew tap for Burin

\`\`\`sh
brew tap burin-labs/burin
brew install burin
brew install --cask burin-code
\`\`\`

\`burin\` installs the cross-platform terminal UI. \`burin-code\` installs the
macOS IDE from the signed DMG release artifact.

Current versions:

- \`burin\`: ${cliVersion}
- \`burin-code\`: ${appVersion}

The formula and cask are generated from the \`release.json\` asset published by
\`burin-labs/burin-code\` releases:

\`\`\`sh
node script/update-from-release.mjs --release-manifest /path/to/release.json
\`\`\`

CI always runs \`brew style\`, \`brew audit\`, and the generator fixture test.
Install smoke runs when the referenced release assets are publicly reachable.
`
}

function requireArtifact(value, name) {
  if (typeof value !== "object" || value === null) {
    throw new Error(`release manifest is missing artifacts.${name}`)
  }
  return {
    path: requireString(value.path, `${name}.path`),
    sha256: requireSha256(value.sha256, `${name}.sha256`),
    sizeBytes: requireNumber(value.sizeBytes, `${name}.sizeBytes`),
    url: requireString(value.url, `${name}.url`),
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`release manifest field ${name} must be a non-empty string`)
  }
  return value
}

function requireNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`release manifest field ${name} must be a non-negative number`)
  }
  return value
}

function requireSha256(value, name) {
  const sha = requireString(value, name)
  if (!/^[0-9a-f]{64}$/i.test(sha)) {
    throw new Error(`release manifest field ${name} must be a sha256 hex digest`)
  }
  return sha.toLowerCase()
}

function macosSymbol(version) {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10)
  if (major >= 15) {
    return "sequoia"
  }
  if (major === 14) {
    return "sonoma"
  }
  if (major === 13) {
    return "ventura"
  }
  throw new Error(`unsupported minimum macOS version: ${version}`)
}

function write(path, content) {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function parseArgs(argv) {
  const out = { releaseManifest: "" }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--release-manifest") {
      out.releaseManifest = argv[++i] ?? ""
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: update-from-release.mjs --release-manifest release.json\n")
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.releaseManifest) {
    throw new Error("--release-manifest is required")
  }
  updateFromReleaseManifest(args.releaseManifest)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`update-from-release: ${error.message}\n`)
    process.exit(1)
  })
}
