#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL, URL } from "node:url"

export const PUBLIC_RELEASE_REPOSITORY = "burin-labs/burin-releases"

export function updateFromReleaseManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf-8"))
  const version = requireString(manifest.version, "version")
  const minimumSystemVersion = requireString(
    manifest.minimumSystemVersion,
    "minimumSystemVersion",
  )
  const cliVersion = requireString(manifest.cliVersion ?? manifest.version, "cliVersion")
  const releaseTag = releaseTagForVersion(version)
  const dmg = requireArtifact(
    manifest.artifacts?.["macos-arm64-dmg"],
    "macos-arm64-dmg",
    releaseTag,
  )
  // Each standalone archive owns the executable pair and its frozen package.
  const binaries = requireBinaryArtifacts(manifest.artifacts, releaseTag)

  write("Casks/burin-code.rb", renderCask({ version, dmg, minimumSystemVersion }))
  write("Formula/burin.rb", renderFormula({ version: cliVersion, binaries }))
  write("README.md", renderReadme({ appVersion: version, cliVersion }))
}

export function renderCask({ version, dmg, minimumSystemVersion }) {
  return `cask "burin-code" do
  version "${version}"
  sha256 "${dmg.sha256}"

  url "${dmg.url}"
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

/// Release-manifest key -> the Homebrew block the archive belongs in.
///
/// Windows is published too, and deliberately absent here: Homebrew has no
/// target for it.
export const BINARY_ARTIFACTS = [
  { key: "cli-darwin-arm64", os: "macos", cpu: "arm" },
  { key: "cli-darwin-x64", os: "macos", cpu: "intel" },
  { key: "cli-linux-x64", os: "linux", cpu: "intel" },
  { key: "cli-linux-arm64", os: "linux", cpu: "arm" },
]

export function renderFormula({ version, binaries }) {
  return `class Burin < Formula
  desc "AI-native terminal coding workbench"
  homepage "https://burincode.com/"
  version "${version}"
  license :cannot_represent

${renderPlatformBlocks(binaries)}
  def install
    # Keep the exact released runtime beside Burin. Only Burin is exposed on
    # PATH, so an independently installed Harn command retains its own version.
    libexec.install "burin", "harn", "pipelines", "provider-catalog", "providers.toml",
                    "harn.toml", "harn.lock", ".harn", "LICENSE", "THIRD-PARTY-NOTICES.txt",
                    "harn-licenses"
    bin.install_symlink libexec/"burin"
  end

  test do
    require "json"

    assert_match version.to_s, shell_output("#{bin}/burin --version")
    assert_path_exists libexec/"pipelines/mode/auto.harn"
    assert_path_exists libexec/"harn"
    assert_path_exists libexec/"LICENSE"
    assert_path_exists libexec/"harn-licenses/LICENSE-MIT"
    assert_path_exists libexec/"harn-licenses/LICENSE-APACHE"
    assert_path_exists libexec/"harn-licenses/THIRD-PARTY-NOTICES.txt"
    assert_path_exists libexec/"THIRD-PARTY-NOTICES.txt"
    # A bare binary answers --version with no pipelines at all, and a binary
    # that finds its pipelines can still fail to compile them. So run a real
    # subcommand and read its result, rather than grepping for the absence of
    # one error string.
    report = JSON.parse(shell_output("#{bin}/burin headless --project #{testpath} diagnose"))
    assert_equal "diagnose", report["action"]
    assert_equal 0, report["exit_code"]
  end
end
`
}

function renderPlatformBlocks(binaries) {
  const byOs = new Map()
  for (const { key, os, cpu } of BINARY_ARTIFACTS) {
    const artifact = binaries[key]
    if (!artifact) {
      continue
    }
    if (!byOs.has(os)) {
      byOs.set(os, [])
    }
    byOs.get(os).push({ cpu, artifact })
  }
  return [...byOs.entries()]
    .map(([os, entries]) => {
      const inner = entries
        .map(
          ({ cpu, artifact }) =>
            `    on_${cpu} do\n` +
            `      url "${artifact.url}"\n` +
            `      sha256 "${artifact.sha256}"\n` +
            `    end\n`,
        )
        .join("\n")
      return `  on_${os} do\n${inner}  end\n`
    })
    .join("\n")
}

export function renderReadme({ appVersion, cliVersion }) {
  return `# Homebrew tap for Burin

\`\`\`sh
brew tap burin-labs/burin
brew install harn
brew install burin
brew install --cask burin-code
\`\`\`

\`harn\` installs the Harn runtime and CLI, including \`harn serve acp\` for
third-party ACP hosts. \`burin\` installs the cross-platform terminal UI.
\`burin-code\` installs the macOS IDE from the signed DMG release artifact.

Current versions:

- \`harn\`: see \`Formula/harn.rb\`
- \`burin\`: ${cliVersion}
- \`burin-code\`: ${appVersion}

The \`burin\` formula and \`burin-code\` cask are generated from the
\`release.json\` asset published by \`${PUBLIC_RELEASE_REPOSITORY}\` releases:

\`\`\`sh
node script/update-from-release.mjs --release-manifest /path/to/release.json
\`\`\`

The \`harn\` formula is generated from a Harn GitHub release JSON object:

\`\`\`sh
gh release view --repo burin-labs/harn --json tagName,assets \\
  > /tmp/harn-release.json
node script/update-harn-from-release.mjs --release-json /tmp/harn-release.json
\`\`\`

CI always runs \`brew style\`, \`brew audit\`, and the generator fixture tests.
Install smoke runs when the referenced release assets are publicly reachable.

See [RELEASING.md](RELEASING.md) for what has to be true before a regenerated
formula actually installs, and what changes when \`burin-code\` goes public.
`
}

// Hard allowlist for artifact URLs. The tap install flow ships whatever URL
// the release manifest names; without an allowlist a malicious or compromised
// release.json could redirect Formula/Cask installs to an attacker-controlled
// host. Validate both the Formula and Cask artifacts here; supported Homebrew
// versions reject the former `verified:` Cask URL parameter.
const ARTIFACT_URL_HOST = "github.com"
const ARTIFACT_URL_PATH_PREFIX = `/${PUBLIC_RELEASE_REPOSITORY}/releases/download/`

/// Every Homebrew-servable platform archive, all of them required.
///
/// A missing key is a release-pipeline failure, not a platform to silently
/// omit: a formula rendered without one installs cleanly on that platform and
/// then has no URL to fetch, so the failure surfaces at the user rather than
/// at the generator that could have caught it.
function requireBinaryArtifacts(artifacts, releaseTag) {
  const resolved = {}
  for (const { key } of BINARY_ARTIFACTS) {
    resolved[key] = requireArtifact(artifacts?.[key], key, releaseTag)
  }
  return resolved
}

function requireArtifact(value, name, releaseTag) {
  if (typeof value !== "object" || value === null) {
    throw new Error(`release manifest is missing artifacts.${name}`)
  }
  const path = requireString(value.path, `${name}.path`)
  return {
    path,
    sha256: requireSha256(value.sha256, `${name}.sha256`),
    sizeBytes: requireNumber(value.sizeBytes, `${name}.sizeBytes`),
    url: requireArtifactUrl(value.url, `${name}.url`, releaseTag, path),
  }
}

function requireArtifactUrl(value, name, releaseTag, artifactPath) {
  const url = requireString(value, name)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`release manifest field ${name} must be a valid URL`)
  }
  const expectedPathPrefix = `${ARTIFACT_URL_PATH_PREFIX}${releaseTag}/`
  const artifactName = artifactPath.split("/").pop()
  const urlArtifactName = decodeURIComponent(parsed.pathname.split("/").pop() ?? "")
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== ARTIFACT_URL_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !parsed.pathname.startsWith(expectedPathPrefix)
  ) {
    throw new Error(
      `release manifest field ${name} must be a GitHub release asset URL under https://${ARTIFACT_URL_HOST}${expectedPathPrefix} (got ${url})`,
    )
  }
  if (urlArtifactName !== artifactName) {
    throw new Error(
      `release manifest field ${name} URL artifact name must match ${artifactPath} (got ${urlArtifactName})`,
    )
  }
  return url
}

function releaseTagForVersion(version) {
  return version.startsWith("v") ? version : `v${version}`
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
  if (major >= 26) {
    return "tahoe"
  }
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
  const out = { releaseManifest: "", printRepository: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--release-manifest") {
      out.releaseManifest = argv[++i] ?? ""
    } else if (arg === "--print-release-repository") {
      out.printRepository = true
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: update-from-release.mjs --release-manifest release.json\n       update-from-release.mjs --print-release-repository\n")
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.printRepository) {
    if (args.releaseManifest) {
      throw new Error("--print-release-repository cannot regenerate files")
    }
    process.stdout.write(`${PUBLIC_RELEASE_REPOSITORY}\n`)
    return
  }
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
