#!/usr/bin/env node
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { harnReleaseManifest, updateHarnFromRelease } from "./update-harn-from-release.mjs"

const root = mkdtempSync(join(tmpdir(), "burin-homebrew-harn-test-"))
const originalCwd = process.cwd()

try {
  process.chdir(root)
  const releasePath = join(root, "harn-release.json")
  writeFileSync(releasePath, `${JSON.stringify(releaseFixture())}\n`)

  const manifest = harnReleaseManifest(releaseFixture())
  assert.equal(manifest.assets.length, 4)
  assert.deepEqual(manifest.assets.map((asset) => asset.name), [
    "harn-aarch64-apple-darwin.tar.gz",
    "harn-x86_64-apple-darwin.tar.gz",
    "harn-aarch64-unknown-linux-gnu.tar.gz",
    "harn-x86_64-unknown-linux-gnu.tar.gz",
  ])

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
  assert.match(formula, /pkgshare\.install notices/)
  assert.match(formula, /harn --help/)
  // The tap is how a stranger finds this software, so the formula has to say
  // what it is before they depend on it.
  assert.match(formula, /pre-release software and is not yet supported/)
  assert.match(formula, /Expect breaking changes between releases/)

  if (process.argv.includes("--install-fixture")) {
    testInstalledNotices(join(root, "Formula/harn.rb"))
  }

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

function testInstalledNotices(formulaPath) {
  const ruby = `
    load ARGV.fetch(0)
    formula = Harn.new("harn", Pathname.new(ARGV.fetch(0)), :stable)
    source = Pathname.new(ARGV.fetch(1))
    destination = Pathname.new(ARGV.fetch(2))
    formula.define_singleton_method(:prefix) { destination }
    formula.define_singleton_method(:buildpath) { source }
    Dir.chdir(source) { formula.install }
    formula.prefix.install_metafiles(source)
  `
  const notices = "Exact full dependency license and attribution fixture bytes.\\n"
  for (const state of ["present", "missing", "empty", "directory", "symlink"]) {
    const source = join(root, `archive-${state}`)
    const destination = join(root, `keg-${state}`)
    mkdirSync(source)
    mkdirSync(destination)
    writeFileSync(join(source, "harn"), "runtime fixture bytes")
    writeFileSync(join(source, "LICENSE-MIT"), "Exact MIT fixture bytes")
    writeFileSync(join(source, "LICENSE-APACHE"), "Exact Apache fixture bytes")
    const noticePath = join(source, "THIRD-PARTY-NOTICES.txt")
    if (state === "present") writeFileSync(noticePath, notices)
    if (state === "empty") writeFileSync(noticePath, "")
    if (state === "directory") mkdirSync(noticePath)
    if (state === "symlink") {
      const outside = join(root, "outside-notices.txt")
      writeFileSync(outside, notices)
      symlinkSync(outside, noticePath)
    }
    const result = spawnSync("brew", ["ruby", "-rformula", "-e", ruby, formulaPath, source, destination], {
      encoding: "utf8",
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1" },
    })
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    assert.ifError(result.error)
    if (state === "present") {
      assert.equal(result.status, 0, output)
      assert.equal(readFileSync(join(destination, "share/harn/THIRD-PARTY-NOTICES.txt"), "utf8"), notices)
      assert.equal(readFileSync(join(destination, "LICENSE-MIT"), "utf8"), "Exact MIT fixture bytes")
      assert.equal(readFileSync(join(destination, "LICENSE-APACHE"), "utf8"), "Exact Apache fixture bytes")
      assert.equal(readFileSync(join(destination, "bin/harn"), "utf8"), "runtime fixture bytes")
    } else {
      assert.notEqual(result.status, 0, `${state} notices installed successfully`)
      assert.match(output, /Harn archive must contain nonempty regular THIRD-PARTY-NOTICES\.txt/)
    }
  }
  console.log("Generated Harn formula: exact installed notice/license bytes; missing, empty, directory and symlink refusals passed")
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
