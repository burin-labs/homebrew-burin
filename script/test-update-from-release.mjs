#!/usr/bin/env node
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { updateFromReleaseManifest } from "./update-from-release.mjs"

const root = mkdtempSync(join(tmpdir(), "burin-homebrew-test-"))
const originalCwd = process.cwd()

try {
  process.chdir(root)
  const manifestPath = join(root, "release.json")
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 2,
      version: "1.2.3",
      cliVersion: "1.2.4",
      minimumSystemVersion: "14.0",
      artifacts: {
        "macos-arm64-dmg": {
          path: "Burin.Code.dmg",
          sha256: "a".repeat(64),
          sizeBytes: 10,
          url: "https://github.com/burin-labs/burin-code/releases/download/v1.2.3/Burin.Code.dmg",
        },
        "cli-npm-tarball": {
          path: "burin-cli-1.2.4.tgz",
          sha256: "b".repeat(64),
          sizeBytes: 20,
          url: "https://github.com/burin-labs/burin-code/releases/download/v1.2.3/burin-cli-1.2.4.tgz",
        },
      },
    })}\n`,
  )

  updateFromReleaseManifest(manifestPath)

  const cask = readFileSync("Casks/burin-code.rb", "utf-8")
  const formula = readFileSync("Formula/burin.rb", "utf-8")
  const readme = readFileSync("README.md", "utf-8")

  assert.match(cask, /version "1\.2\.3"/)
  assert.match(cask, /sha256 "aaaaaaaa/)
  assert.match(cask, /depends_on macos: :sonoma/)
  assert.match(formula, /url "https:\/\/github\.com\/burin-labs\/burin-code\/releases\/download\/v1\.2\.3\/burin-cli-1\.2\.4\.tgz"/)
  assert.match(formula, /sha256 "bbbbbbbb/)
  assert.match(readme, /`burin`: 1\.2\.4/)
  assert.match(readme, /`burin-code`: 1\.2\.3/)

  console.log("test-update-from-release: OK")
} finally {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
}
