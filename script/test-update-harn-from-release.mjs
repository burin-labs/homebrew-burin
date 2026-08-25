#!/usr/bin/env node
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { updateHarnFromRelease } from "./update-harn-from-release.mjs"

const root = mkdtempSync(join(tmpdir(), "burin-homebrew-harn-test-"))
const originalCwd = process.cwd()

try {
  process.chdir(root)
  const releasePath = join(root, "harn-release.json")
  writeFileSync(releasePath, `${JSON.stringify(releaseFixture())}\n`)

  updateHarnFromRelease(releasePath)

  const formula = readFileSync("Formula/harn.rb", "utf-8")
  assert.match(formula, /class Harn < Formula/)
  assert.match(formula, /Homebrew misreads x86_64 target triples as versions/)
  assert.match(formula, /version "1\.2\.3"/)
  assert.match(formula, /releases\/download\/v#\{version\}\/harn-aarch64-apple-darwin\.tar\.gz/)
  assert.match(formula, /harn-aarch64-apple-darwin\.tar\.gz/)
  assert.match(formula, /sha256 "aaaaaaaa/)
  assert.match(formula, /harn-x86_64-unknown-linux-gnu\.tar\.gz/)
  assert.match(formula, /sha256 "dddddddd/)
  assert.match(formula, /bin\.install "harn"/)
  assert.match(formula, /harn --help/)
  // The tap is how a stranger finds this software, so the formula has to say
  // what it is before they depend on it.
  assert.match(formula, /pre-release software and is not yet supported/)
  assert.match(formula, /Expect breaking changes between releases/)

  const maliciousReleasePath = join(root, "harn-release-malicious.json")
  const malicious = releaseFixture()
  malicious.assets[0].url =
    "https://evil.example.com/burin-labs/harn/releases/download/v1.2.3/harn-aarch64-apple-darwin.tar.gz"
  writeFileSync(maliciousReleasePath, `${JSON.stringify(malicious)}\n`)
  assert.throws(
    () => updateHarnFromRelease(maliciousReleasePath),
    /must be https:\/\/github\.com\/burin-labs\/harn\/releases\/download\/v1\.2\.3\/harn-aarch64-apple-darwin\.tar\.gz/,
  )

  const wrongDigestPath = join(root, "harn-release-wrong-digest.json")
  const wrongDigest = releaseFixture()
  wrongDigest.assets[1].digest = "md5:bbbb"
  writeFileSync(wrongDigestPath, `${JSON.stringify(wrongDigest)}\n`)
  assert.throws(
    () => updateHarnFromRelease(wrongDigestPath),
    /must start with sha256:/,
  )

  const missingAssetPath = join(root, "harn-release-missing-asset.json")
  const missingAsset = releaseFixture()
  missingAsset.assets = missingAsset.assets.filter(
    (asset) => asset.name !== "harn-x86_64-apple-darwin.tar.gz",
  )
  writeFileSync(missingAssetPath, `${JSON.stringify(missingAsset)}\n`)
  assert.throws(
    () => updateHarnFromRelease(missingAssetPath),
    /missing asset harn-x86_64-apple-darwin\.tar\.gz/,
  )

  console.log("test-update-harn-from-release: OK")
} finally {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
}

function releaseFixture() {
  return {
    tagName: "v1.2.3",
    assets: [
      {
        name: "harn-aarch64-apple-darwin.tar.gz",
        digest: `sha256:${"a".repeat(64)}`,
        url: "https://github.com/burin-labs/harn/releases/download/v1.2.3/harn-aarch64-apple-darwin.tar.gz",
      },
      {
        name: "harn-x86_64-apple-darwin.tar.gz",
        digest: `sha256:${"b".repeat(64)}`,
        url: "https://github.com/burin-labs/harn/releases/download/v1.2.3/harn-x86_64-apple-darwin.tar.gz",
      },
      {
        name: "harn-aarch64-unknown-linux-gnu.tar.gz",
        digest: `sha256:${"c".repeat(64)}`,
        url: "https://github.com/burin-labs/harn/releases/download/v1.2.3/harn-aarch64-unknown-linux-gnu.tar.gz",
      },
      {
        name: "harn-x86_64-unknown-linux-gnu.tar.gz",
        digest: `sha256:${"d".repeat(64)}`,
        url: "https://github.com/burin-labs/harn/releases/download/v1.2.3/harn-x86_64-unknown-linux-gnu.tar.gz",
      },
      {
        name: "harn-x86_64-pc-windows-msvc.zip",
        digest: `sha256:${"e".repeat(64)}`,
        url: "https://github.com/burin-labs/harn/releases/download/v1.2.3/harn-x86_64-pc-windows-msvc.zip",
      },
    ],
  }
}
