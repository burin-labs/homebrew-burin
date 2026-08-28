#!/usr/bin/env node
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { updateFromReleaseManifest } from "./update-from-release.mjs"

const root = mkdtempSync(join(tmpdir(), "burin-homebrew-test-"))
const originalCwd = process.cwd()

const RELEASE_BASE =
  "https://github.com/burin-labs/burin-code/releases/download/v1.2.3"

const CLI_ARCHIVES = {
  "cli-darwin-arm64": "burin-aarch64-apple-darwin.tar.gz",
  "cli-darwin-x64": "burin-x86_64-apple-darwin.tar.gz",
  "cli-linux-x64": "burin-x86_64-unknown-linux-gnu.tar.gz",
  "cli-linux-arm64": "burin-aarch64-unknown-linux-gnu.tar.gz",
}

/// A complete, valid manifest, with `overrides` merged over its artifacts.
///
/// Every negative case below differs from the happy path in exactly one
/// artifact, so building them by override keeps the difference visible instead
/// of burying it in a repeated literal.
function manifest(artifactOverrides = {}) {
  const artifacts = {
    "macos-arm64-dmg": {
      path: "Burin.Code.dmg",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      url: `${RELEASE_BASE}/Burin.Code.dmg`,
    },
    "cli-npm-tarball": {
      path: "burin-cli-1.2.4.tgz",
      sha256: "b".repeat(64),
      sizeBytes: 20,
      url: `${RELEASE_BASE}/burin-cli-1.2.4.tgz`,
    },
  }
  for (const [key, path] of Object.entries(CLI_ARCHIVES)) {
    artifacts[key] = {
      path,
      sha256: "c".repeat(64),
      sizeBytes: 30,
      url: `${RELEASE_BASE}/${path}`,
    }
  }
  return {
    schemaVersion: 2,
    version: "1.2.3",
    cliVersion: "1.2.4",
    minimumSystemVersion: "14.0",
    artifacts: { ...artifacts, ...artifactOverrides },
  }
}

function writeManifest(name, value) {
  const path = join(root, `${name}.json`)
  writeFileSync(path, `${JSON.stringify(value)}\n`)
  return path
}

try {
  process.chdir(root)

  updateFromReleaseManifest(writeManifest("release", manifest()))

  const cask = readFileSync("Casks/burin-code.rb", "utf-8")
  const formula = readFileSync("Formula/burin.rb", "utf-8")
  const readme = readFileSync("README.md", "utf-8")

  assert.match(cask, /version "1\.2\.3"/)
  assert.match(cask, /sha256 "aaaaaaaa/)
  assert.match(cask, /depends_on macos: :sonoma/)

  // The formula installs the standalone archive for the running platform.
  assert.match(formula, /version "1\.2\.4"/)
  assert.match(
    formula,
    /on_macos do\n {4}on_arm do\n {6}url ".*burin-aarch64-apple-darwin\.tar\.gz"/,
  )
  assert.match(formula, /burin-x86_64-apple-darwin\.tar\.gz/)
  assert.match(
    formula,
    /on_linux do\n {4}on_intel do\n {6}url ".*burin-x86_64-unknown-linux-gnu\.tar\.gz"/,
  )
  assert.match(formula, /burin-aarch64-unknown-linux-gnu\.tar\.gz/)
  assert.match(formula, /bin\.install "burin"/)

  // Homebrew has no Windows target, so the published Windows archive must not
  // reach the formula.
  assert.doesNotMatch(formula, /windows|win32/i)

  // The npm shim is a data payload here, not the thing being installed. It
  // carries no binary: it resolves one from a per-platform optionalDependency
  // and soft-fails when that is missing, which is an exit-0 install and a
  // failure on first run. Installing it must not come back.
  assert.match(formula, /resource "bundle" do\n {4}url ".*burin-cli-1\.2\.4\.tgz"/)
  assert.doesNotMatch(formula, /npm/)
  assert.doesNotMatch(formula, /node@22/)

  // Pipelines land where `resolve_pipelines_root` probes. Without them the
  // binary answers `--version` and fails every agent turn, so the layout is
  // asserted rather than assumed.
  assert.match(
    formula,
    /pkgshare\.install "pipelines", "provider-catalog", "providers\.toml",\n\s+"harn\.toml", "harn\.lock", "\.harn"/,
  )
  assert.match(formula, /assert_path_exists pkgshare\/"pipelines\/mode\/auto\.harn"/)
  // brew audit --strict flags share/"burin" when pkgshare is the idiom.
  // The on-disk path is unchanged (pkgshare == share/name).
  assert.doesNotMatch(formula, /share\/"burin"/)

  // The Harn package boundary is what lets the bundled pipelines compile
  // outside a checkout, and `harn` is what compiles them. A formula that
  // installs the tree without either produces a binary that finds its
  // pipelines and cannot run one.
  assert.match(formula, /depends_on "burin-labs\/burin\/harn"/)

  // The test block reads a real result. Grepping for the absence of one known
  // error string passed against a product that could not run at all.
  assert.match(formula, /assert_equal 0, report\["exit_code"\]/)
  assert.doesNotMatch(formula, /refute_match "pipeline directory not found"/)

  // The formula shipped a wrapper setting BURIN_PIPELINE_DIR while burin had
  // two disagreeing pipeline resolvers. burin-code#6417 gave resolution one
  // owner that probes `<exe_dir>/../share/burin/pipelines`, so the layout above
  // is enough and the wrapper is gone. Asserted so it does not creep back as a
  // fix for something it would only mask.
  assert.doesNotMatch(formula, /BURIN_PIPELINE_DIR/)
  assert.doesNotMatch(formula, /libexec/)

  // A bare binary answers --version with no pipelines at all, so the formula's
  // own test has to reach past it.
  assert.match(formula, /burin headless --project #\{testpath\} diagnose/)

  assert.match(readme, /brew install harn/)
  assert.match(readme, /`harn`: see `Formula\/harn\.rb`/)
  assert.match(readme, /`burin`: 1\.2\.4/)
  assert.match(readme, /`burin-code`: 1\.2\.3/)
  assert.match(
    readme,
    /gh release view --repo burin-labs\/harn --json tagName,assets/,
  )
  assert.doesNotMatch(readme, /gh release view v\d/)
  assert.match(readme, /\[RELEASING\.md\]\(RELEASING\.md\)/)

  assert.match(
    renderCaskFromMinimumSystemVersion("26.0"),
    /depends_on macos: :tahoe/,
  )

  // A release that did not publish every platform archive is a pipeline
  // failure. Rendering a formula without one installs cleanly on that platform
  // and then has no URL to fetch, so the generator refuses instead.
  for (const key of Object.keys(CLI_ARCHIVES)) {
    const incomplete = manifest()
    delete incomplete.artifacts[key]
    assert.throws(
      () => updateFromReleaseManifest(writeManifest(`release-missing-${key}`, incomplete)),
      new RegExp(`release manifest is missing artifacts\\.${key}`),
      `a manifest without ${key} must be rejected`,
    )
  }

  // Allowlist enforcement: a manifest pointing at a non-burin-labs URL must
  // be rejected before any Formula/Cask is written.
  assert.throws(
    () =>
      updateFromReleaseManifest(
        writeManifest(
          "release-malicious",
          manifest({
            "macos-arm64-dmg": {
              path: "Burin.Code.dmg",
              sha256: "a".repeat(64),
              sizeBytes: 10,
              url: "https://evil.example.com/burin-labs/burin-code/releases/download/v1.2.3/Burin.Code.dmg",
            },
          }),
        ),
      ),
    /must be a GitHub release asset URL under https:\/\/github\.com\/burin-labs\/burin-code\/releases\/download\//,
  )

  assert.throws(
    () =>
      updateFromReleaseManifest(
        writeManifest(
          "release-malicious-cli",
          manifest({
            "cli-npm-tarball": {
              path: "burin-cli-1.2.4.tgz",
              sha256: "b".repeat(64),
              sizeBytes: 20,
              url: "https://registry.npmjs.org/@evil/burin-cli/-/burin-cli-1.2.4.tgz",
            },
          }),
        ),
      ),
    /must be a GitHub release asset URL under https:\/\/github\.com\/burin-labs\/burin-code\/releases\/download\//,
  )

  // The same allowlist must cover the platform archives, which are the assets
  // a plain `brew install` actually downloads and executes.
  assert.throws(
    () =>
      updateFromReleaseManifest(
        writeManifest(
          "release-malicious-archive",
          manifest({
            "cli-darwin-arm64": {
              path: "burin-aarch64-apple-darwin.tar.gz",
              sha256: "c".repeat(64),
              sizeBytes: 30,
              url: "https://evil.example.com/burin-aarch64-apple-darwin.tar.gz",
            },
          }),
        ),
      ),
    /must be a GitHub release asset URL under https:\/\/github\.com\/burin-labs\/burin-code\/releases\/download\//,
  )

  assert.throws(
    () =>
      updateFromReleaseManifest(
        writeManifest(
          "release-non-release-path",
          manifest({
            "macos-arm64-dmg": {
              path: "Burin.Code.dmg",
              sha256: "a".repeat(64),
              sizeBytes: 10,
              url: "https://github.com/burin-labs/burin-code/archive/refs/tags/v1.2.3.tar.gz",
            },
          }),
        ),
      ),
    /must be a GitHub release asset URL under https:\/\/github\.com\/burin-labs\/burin-code\/releases\/download\//,
  )

  assert.throws(
    () =>
      updateFromReleaseManifest(
        writeManifest(
          "release-wrong-tag",
          manifest({
            "macos-arm64-dmg": {
              path: "Burin.Code.dmg",
              sha256: "a".repeat(64),
              sizeBytes: 10,
              url: "https://github.com/burin-labs/burin-code/releases/download/v1.2.2/Burin.Code.dmg",
            },
          }),
        ),
      ),
    /must be a GitHub release asset URL under https:\/\/github\.com\/burin-labs\/burin-code\/releases\/download\/v1\.2\.3\//,
  )

  assert.throws(
    () =>
      updateFromReleaseManifest(
        writeManifest(
          "release-mismatched-artifact-name",
          manifest({
            "macos-arm64-dmg": {
              path: "Burin.Code.dmg",
              sha256: "a".repeat(64),
              sizeBytes: 10,
              url: `${RELEASE_BASE}/Other.dmg`,
            },
          }),
        ),
      ),
    /URL artifact name must match Burin\.Code\.dmg/,
  )

  console.log("test-update-from-release: OK")
} finally {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
}

function renderCaskFromMinimumSystemVersion(minimumSystemVersion) {
  const value = manifest()
  value.minimumSystemVersion = minimumSystemVersion
  updateFromReleaseManifest(
    writeManifest(`release-macos-${minimumSystemVersion}`, value),
  )
  return readFileSync("Casks/burin-code.rb", "utf-8")
}
