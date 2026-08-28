#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  EXIT,
  classifyFormulaSource,
  classifyStableUrl,
  extractStableUrl,
  formatGithubOutput,
  githubAnnotation,
  githubOutputs,
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

function runCli(formulaSource, { curlExit, extraEnv } = {}) {
  const root = mkdtempSync(join(tmpdir(), "formula-url-preflight-"))
  const formulaPath = join(root, "burin.rb")
  const env = { ...process.env, ...extraEnv }
  delete env.GITHUB_ACTIONS
  if (!extraEnv?.GITHUB_OUTPUT) {
    delete env.GITHUB_OUTPUT
  }
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

const noUrlOutputs = githubOutputs(noUrl)
const unreachableOutputs = githubOutputs(unreachable)
const okOutputs = githubOutputs(ok)
assert.equal(noUrlOutputs.should_install, "false")
assert.equal(unreachableOutputs.should_install, "false")
assert.equal(okOutputs.should_install, "true")
assert.equal(noUrlOutputs.status, "no-url")
assert.equal(unreachableOutputs.status, "unreachable")
assert.notEqual(noUrl.message, unreachable.message)
assert.match(formatGithubOutput(noUrl), /^should_install=false$/m)
assert.match(formatGithubOutput(ok), /^should_install=true$/m)
assert.match(githubAnnotation(noUrl), /^::warning::/)
assert.match(githubAnnotation(unreachable), /^::notice::/)
assert.equal(githubAnnotation(ok), "")

const outputRoot = mkdtempSync(join(tmpdir(), "formula-url-preflight-out-"))
const outputPath = join(outputRoot, "github-output")
try {
  const withOutput = runCli(HEAD_ONLY, { extraEnv: { GITHUB_OUTPUT: outputPath } })
  assert.equal(withOutput.status, EXIT.noUrl)
  const written = readFileSync(outputPath, "utf8")
  assert.match(written, /^status=no-url$/m)
  assert.match(written, /^should_install=false$/m)
} finally {
  rmSync(outputRoot, { recursive: true, force: true })
}

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
assert.match(ci, /name: Formula URL preflight/)
assert.match(
  ci,
  /if: needs\.formula-url-preflight\.outputs\.should_install == 'true'/,
)
assert.match(ci, /success\|skipped/)
assert.doesNotMatch(
  ci,
  /Skipping formula install smoke because no stable formula URL is publicly reachable yet/,
)
const installJob = ci.match(/formula-install-smoke:\n[\s\S]*?(?=\n  [a-z-]+:)/)?.[0]
assert.ok(installJob, "formula-install-smoke job must exist")
assert.match(installJob, /brew install burin-labs\/burin\/burin/)
assert.doesNotMatch(
  installJob,
  /echo "Skipping formula install smoke/,
  "install job must not silent-green skip",
)

console.log("test-formula-url-preflight: OK")
