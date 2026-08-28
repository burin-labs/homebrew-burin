#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  EXIT,
  classifyFormulaSource,
  classifyStableUrl,
  extractStableUrl,
} from "./formula-url-preflight.mjs"

const HEAD_ONLY = `class Burin < Formula
  desc "AI-native terminal coding workbench"
  homepage "https://burincode.com/"
  license "Apache-2.0"
  head "https://github.com/burin-labs/burin-code.git", branch: "main"
end
`

const STABLE = `class Burin < Formula
  desc "AI-native terminal coding workbench"
  homepage "https://burincode.com/"
  url "https://example.invalid/burin-1.2.3.tar.gz"
  sha256 "${"a".repeat(64)}"
  head "https://github.com/burin-labs/burin-code.git", branch: "main"
end
`

const STABLE_URL = "https://example.invalid/burin-1.2.3.tar.gz"
const SCRIPT = fileURLToPath(new URL("./formula-url-preflight.mjs", import.meta.url))

function runCli(formulaSource, { curlExit } = {}) {
  const root = mkdtempSync(join(tmpdir(), "formula-url-preflight-"))
  const formulaPath = join(root, "burin.rb")
  const env = { ...process.env }
  try {
    writeFileSync(formulaPath, formulaSource)
    if (curlExit !== undefined) {
      const curlBin = join(root, "curl")
      writeFileSync(curlBin, `#!/bin/sh\nexit ${curlExit}\n`, { mode: 0o755 })
      env.CURL_BIN = curlBin
    }
    return spawnSync(process.execPath, [SCRIPT, formulaPath], {
      encoding: "utf8",
      env,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

assert.equal(extractStableUrl(HEAD_ONLY), "")
assert.equal(extractStableUrl(STABLE), STABLE_URL)

const noUrl = classifyStableUrl("", false)
assert.equal(noUrl.status, "no-url")
assert.equal(noUrl.exitCode, EXIT.noUrl)
assert.notEqual(noUrl.exitCode, 0)

const unreachable = classifyStableUrl(STABLE_URL, false)
assert.equal(unreachable.status, "unreachable")
assert.equal(unreachable.exitCode, EXIT.unreachable)
assert.notEqual(unreachable.exitCode, 0)
assert.match(unreachable.message, /example\.invalid\/burin-1\.2\.3\.tar\.gz/)

const ok = classifyStableUrl(STABLE_URL, true)
assert.equal(ok.status, "ok")
assert.equal(ok.exitCode, EXIT.ok)
assert.equal(ok.url, STABLE_URL)

assert.equal(classifyFormulaSource(HEAD_ONLY).status, "no-url")
assert.equal(classifyFormulaSource(STABLE, { reachable: false }).status, "unreachable")
assert.equal(classifyFormulaSource(STABLE, { reachable: true }).status, "ok")

const headOnlyCli = runCli(HEAD_ONLY)
assert.notEqual(
  headOnlyCli.status,
  0,
  "head-only formula must not be a silent green skip",
)
assert.equal(headOnlyCli.status, EXIT.noUrl)
assert.match(headOnlyCli.stderr, /no stable url/)

const unreachableCli = runCli(STABLE, { curlExit: 1 })
assert.notEqual(
  unreachableCli.status,
  0,
  "unreachable URL must not be a silent green skip",
)
assert.equal(unreachableCli.status, EXIT.unreachable)
assert.match(unreachableCli.stderr, /example\.invalid\/burin-1\.2\.3\.tar\.gz/)

const reachableCli = runCli(STABLE, { curlExit: 0 })
assert.equal(reachableCli.status, EXIT.ok)
assert.equal(reachableCli.stdout.trim(), STABLE_URL)

console.log("test-formula-url-preflight: OK")
