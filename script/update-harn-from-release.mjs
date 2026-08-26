#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL, URL } from "node:url"

export const HARN_RELEASE_ASSETS = [
  "harn-aarch64-apple-darwin.tar.gz",
  "harn-x86_64-apple-darwin.tar.gz",
  "harn-aarch64-unknown-linux-gnu.tar.gz",
  "harn-x86_64-unknown-linux-gnu.tar.gz",
]

export function updateHarnFromRelease(path) {
  const release = JSON.parse(readFileSync(path, "utf-8"))
  const formula = renderHarnFormula(harnReleaseManifest(release))
  write("Formula/harn.rb", formula)
}

/**
 * Project GitHub's release payload into the one manifest the formula consumes.
 * Other release assets are deliberately ignored, but this projection itself
 * must contain each supported Homebrew archive exactly once.
 */
export function harnReleaseManifest(release) {
  const tag = requireString(release.tagName ?? release.tag_name, "tagName")
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Harn release tag must look like vX.Y.Z, got ${tag}`)
  }
  const rawAssets = release.assets
  if (!Array.isArray(rawAssets)) {
    throw new Error("Harn release JSON must include an assets array")
  }
  return validateHarnReleaseManifest({
    schema_version: 1,
    release_tag: tag,
    assets: HARN_RELEASE_ASSETS.map((name) => parseAsset(rawAssets, tag, name)),
  })
}

export function validateHarnReleaseManifest(manifest) {
  if (manifest?.schema_version !== 1) {
    throw new Error("Harn release manifest schema_version must be 1")
  }
  const tag = requireString(manifest.release_tag, "release_tag")
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Harn release tag must look like vX.Y.Z, got ${tag}`)
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== HARN_RELEASE_ASSETS.length) {
    throw new Error(
      `Harn release manifest must contain exactly ${HARN_RELEASE_ASSETS.length} supported assets`,
    )
  }
  const byName = new Map()
  for (const asset of manifest.assets) {
    const name = requireString(asset?.name, "assets.name")
    if (!HARN_RELEASE_ASSETS.includes(name)) {
      throw new Error(`Harn release manifest contains unsupported asset ${name}`)
    }
    if (byName.has(name)) {
      throw new Error(`Harn release manifest contains duplicate asset ${name}`)
    }
    byName.set(name, {
      name,
      sha256: requireSha256(asset.sha256, `assets.${name}.sha256`),
      url: requireHarnAssetUrl(asset.url, `assets.${name}.url`, tag, name),
    })
  }
  for (const name of HARN_RELEASE_ASSETS) {
    if (!byName.has(name)) {
      throw new Error(`Harn release ${tag} is missing asset ${name}`)
    }
  }
  return {
    schema_version: 1,
    release_tag: tag,
    version: tag.slice(1),
    tag,
    assets: HARN_RELEASE_ASSETS.map((name) => byName.get(name)),
  }
}

export function renderHarnFormula({ version, tag, assets }) {
  const byName = new Map(assets.map((asset) => [asset.name, asset]))
  const target = (name) => {
    const asset = byName.get(name)
    if (!asset) {
      throw new Error(`Harn release ${tag} is missing asset ${name}`)
    }
    return asset
  }
  const macArm = target("harn-aarch64-apple-darwin.tar.gz")
  const macIntel = target("harn-x86_64-apple-darwin.tar.gz")
  const linuxArm = target("harn-aarch64-unknown-linux-gnu.tar.gz")
  const linuxIntel = target("harn-x86_64-unknown-linux-gnu.tar.gz")

  return `class Harn < Formula
  desc "Programmable agent runtime and ACP backend"
  homepage "https://harnlang.com/"
  # Homebrew misreads x86_64 target triples as versions unless they are pinned.
  version "${version}"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "${versionedUrl(macArm.url, tag)}"
      sha256 "${macArm.sha256}"
    else
      url "${versionedUrl(macIntel.url, tag)}"
      sha256 "${macIntel.sha256}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${versionedUrl(linuxArm.url, tag)}"
      sha256 "${linuxArm.sha256}"
    else
      url "${versionedUrl(linuxIntel.url, tag)}"
      sha256 "${linuxIntel.sha256}"
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

      Releases move quickly. Run \`brew upgrade harn\` often; an install left
      alone for a few days is likely to be several releases behind.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/harn --version")
    assert_match "serve", shell_output("#{bin}/harn --help")
  end
end
`
}

function versionedUrl(url, tag) {
  return url.replace(`/releases/download/${tag}/`, "/releases/download/v#{version}/")
}

function parseAsset(rawAssets, tag, name) {
  const raw = rawAssets.find((asset) => asset?.name === name)
  if (!raw) {
    throw new Error(`Harn release ${tag} is missing asset ${name}`)
  }
  return {
    name,
    sha256: requireSha256(assetDigestSha256(raw), `assets.${name}.digest`),
    url: requireHarnAssetUrl(raw.browser_download_url ?? raw.url, `assets.${name}.url`, tag, name),
  }
}

function assetDigestSha256(asset) {
  const digest = requireString(asset.digest, `assets.${asset.name}.digest`)
  if (!digest.startsWith("sha256:")) {
    throw new Error(`assets.${asset.name}.digest must start with sha256:`)
  }
  return digest.slice("sha256:".length)
}

function requireHarnAssetUrl(value, name, tag, assetName) {
  const url = requireString(value, name)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
  const expectedPath = `/burin-labs/harn/releases/download/${tag}/${assetName}`
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== expectedPath
  ) {
    throw new Error(`${name} must be https://github.com${expectedPath}`)
  }
  return url
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function requireSha256(value, name) {
  const sha = requireString(value, name)
  if (!/^[0-9a-f]{64}$/i.test(sha)) {
    throw new Error(`${name} must be a sha256 hex digest`)
  }
  return sha.toLowerCase()
}

function write(path, content) {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function parseArgs(argv) {
  const out = { releaseJson: "" }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--release-json") {
      out.releaseJson = argv[++i] ?? ""
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: update-harn-from-release.mjs --release-json harn-release.json\n")
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.releaseJson) {
    throw new Error("--release-json is required")
  }
  updateHarnFromRelease(args.releaseJson)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`update-harn-from-release: ${error.message}\n`)
    process.exit(1)
  })
}
