#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  EXIT,
  decide,
  formatGithubOutput,
  githubAnnotation,
  githubOutputs,
  parseDeclaration,
} from "./public-install-gate.mjs"

const SCRIPT = fileURLToPath(new URL("./public-install-gate.mjs", import.meta.url))

const OFF = { publicInstallEnabled: false, reason: "burin-code is private", blockedBy: "" }
const ON = { publicInstallEnabled: true, reason: "", blockedBy: "" }

function runCli(declaration, preflightStatus, { extraEnv } = {}) {
  const root = mkdtempSync(join(tmpdir(), "public-install-gate-"))
  const declarationPath = join(root, "public-install.json")
  const env = { ...process.env, ...extraEnv }
  delete env.GITHUB_ACTIONS
  if (!extraEnv?.GITHUB_OUTPUT) {
    delete env.GITHUB_OUTPUT
  }
  try {
    writeFileSync(
      declarationPath,
      typeof declaration === "string" ? declaration : JSON.stringify(declaration),
    )
    return spawnSync(process.execPath, [SCRIPT, declarationPath, preflightStatus], {
      encoding: "utf8",
      env,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// --- declaration parsing is strict, with no defaulting ----------------------

assert.throws(() => parseDeclaration("{"), /not valid JSON/)
assert.throws(
  () => parseDeclaration("{}"),
  /must set `publicInstallEnabled` to a boolean/,
  "an absent flag must not default to false; not knowing is not a pass",
)
assert.throws(
  () => parseDeclaration(JSON.stringify({ publicInstallEnabled: "false" })),
  /must set `publicInstallEnabled` to a boolean/,
  "the string \"false\" is not a boolean and must not be coerced",
)
assert.throws(
  () => parseDeclaration(JSON.stringify({ publicInstallEnabled: false })),
  /gives no `reason`/,
)
assert.throws(
  () => parseDeclaration(JSON.stringify({ publicInstallEnabled: false, reason: "  " })),
  /gives no `reason`/,
)
assert.equal(
  parseDeclaration(JSON.stringify({ publicInstallEnabled: true })).publicInstallEnabled,
  true,
  "an enabled declaration needs no reason",
)

// --- the four-cell truth table ---------------------------------------------

const gatedNoUrl = decide({ declaration: OFF, preflightStatus: "no-url" })
assert.equal(gatedNoUrl.verdict, "gated")
assert.equal(gatedNoUrl.exitCode, EXIT.ok)
assert.equal(gatedNoUrl.requireInstallSmoke, false)
assert.match(gatedNoUrl.message, /burin-code is private/, "the reason must reach the log")

const gatedUnreachable = decide({ declaration: OFF, preflightStatus: "unreachable" })
assert.equal(gatedUnreachable.verdict, "gated")
assert.equal(gatedUnreachable.exitCode, EXIT.ok)
assert.notEqual(
  gatedUnreachable.message,
  gatedNoUrl.message,
  "head-only and unreachable are different facts and must read differently",
)

// The direction a totality gate misses: the formula got fixed, the declaration
// did not, and install smoke would still be permitted to skip.
const stale = decide({ declaration: OFF, preflightStatus: "ok" })
assert.equal(stale.verdict, "declaration-stale")
assert.notEqual(stale.exitCode, EXIT.ok, "a stale declaration must not be green")
assert.equal(stale.exitCode, EXIT.declarationStale)

// Issue #15 itself, after the launch flip.
for (const status of ["no-url", "unreachable"]) {
  const broken = decide({ declaration: ON, preflightStatus: status })
  assert.equal(broken.verdict, "declaration-broken")
  assert.notEqual(broken.exitCode, EXIT.ok)
  assert.equal(broken.exitCode, EXIT.declarationBroken)
  assert.match(broken.message, /homebrew-burin#15/)
}

const live = decide({ declaration: ON, preflightStatus: "ok" })
assert.equal(live.verdict, "live")
assert.equal(live.exitCode, EXIT.ok)
assert.equal(
  live.requireInstallSmoke,
  true,
  "once public install is enabled, a skipped install smoke is a failure",
)

// An unrecognised status must fail rather than fall through to "not ok".
const bogus = decide({ declaration: OFF, preflightStatus: "probably-fine" })
assert.equal(bogus.verdict, "malformed")
assert.notEqual(bogus.exitCode, EXIT.ok)
assert.equal(bogus.requireInstallSmoke, true)

// requireInstallSmoke is true in exactly the states where a skip would lie.
assert.equal(gatedNoUrl.requireInstallSmoke, false)
assert.equal(live.requireInstallSmoke, true)

// --- CLI behaviour ----------------------------------------------------------

const gatedCli = runCli(OFF, "no-url")
assert.equal(gatedCli.status, EXIT.ok)
assert.match(gatedCli.stdout, /^gated: /)
assert.match(gatedCli.stdout, /DISABLED by declaration/)

const staleCli = runCli(OFF, "ok")
assert.notEqual(staleCli.status, 0, "declaration-stale must fail the job")
assert.equal(staleCli.status, EXIT.declarationStale)
assert.match(staleCli.stderr, /publicInstallEnabled to true/)

const brokenCli = runCli(ON, "no-url")
assert.notEqual(brokenCli.status, 0, "declaration-broken must fail the job")
assert.equal(brokenCli.status, EXIT.declarationBroken)

const liveCli = runCli(ON, "ok")
assert.equal(liveCli.status, EXIT.ok)
assert.match(liveCli.stdout, /^live: /)

const malformedCli = runCli("{ not json", "ok")
assert.equal(malformedCli.status, EXIT.malformed)
assert.match(malformedCli.stderr, /not valid JSON/)

const noFlagCli = runCli({ reason: "x" }, "no-url")
assert.equal(noFlagCli.status, EXIT.malformed)

const usageCli = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" })
assert.equal(usageCli.status, EXIT.usage)

// --- GitHub plumbing --------------------------------------------------------

assert.equal(githubOutputs(gatedNoUrl).require_install_smoke, "false")
assert.equal(githubOutputs(live).require_install_smoke, "true")
assert.equal(githubOutputs(gatedNoUrl).verdict, "gated")
assert.match(formatGithubOutput(live), /^require_install_smoke=true$/m)
assert.match(formatGithubOutput(gatedNoUrl), /^verdict=gated$/m)
assert.match(githubAnnotation(gatedNoUrl), /^::warning::/)
assert.match(githubAnnotation(stale), /^::error::/)
assert.match(githubAnnotation(decide({ declaration: ON, preflightStatus: "no-url" })), /^::error::/)
assert.equal(githubAnnotation(live), "")

const outputRoot = mkdtempSync(join(tmpdir(), "public-install-gate-out-"))
const outputPath = join(outputRoot, "github-output")
try {
  const withOutput = runCli(OFF, "no-url", { extraEnv: { GITHUB_OUTPUT: outputPath } })
  assert.equal(withOutput.status, EXIT.ok)
  const written = readFileSync(outputPath, "utf8")
  assert.match(written, /^verdict=gated$/m)
  assert.match(written, /^require_install_smoke=false$/m)
} finally {
  rmSync(outputRoot, { recursive: true, force: true })
}

// --- the committed declaration must itself be valid and match the formula ----

const committed = parseDeclaration(
  readFileSync(new URL("../public-install.json", import.meta.url), "utf8"),
)
const formula = readFileSync(new URL("../Formula/burin.rb", import.meta.url), "utf8")
const hasStableUrl = /^\s*url "/m.test(formula)
assert.equal(
  committed.publicInstallEnabled,
  hasStableUrl,
  "public-install.json and Formula/burin.rb disagree about whether the public can install "
    + "`burin`. Regenerate the formula or flip the declaration; they ship together.",
)

// --- the workflow must actually consume the gate ----------------------------

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
assert.match(ci, /name: Public install gate/)
assert.match(ci, /public-install-gate\.mjs/)
assert.match(ci, /node script\/test-public-install-gate\.mjs/)
const statusJob = ci.match(/ci-status:\n[\s\S]*$/)?.[0]
assert.ok(statusJob, "ci-status job must exist")
assert.match(
  statusJob,
  /REQUIRE_INSTALL_SMOKE/,
  "ci-status must consume require_install_smoke, or a skipped install is still a silent green",
)
assert.match(
  statusJob,
  /GATE_RESULT/,
  "ci-status must require the public install gate job itself to have passed",
)
assert.match(
  statusJob,
  /if \[ "\$\{REQUIRE_INSTALL_SMOKE\}" = "true" \]; then\n\s*test "\$\{INSTALL_RESULT\}" = "success"/,
  "when the gate requires install smoke, ci-status must demand a real success",
)
// The tolerant `success|skipped` branch must survive only *inside* the guard.
const skipBranch = statusJob.indexOf("success|skipped")
const guard = statusJob.indexOf('REQUIRE_INSTALL_SMOKE}" = "true"')
assert.ok(skipBranch > 0 && guard > 0, "both branches must be present")
assert.ok(
  guard < skipBranch,
  "ci-status must decide whether a skip is acceptable before accepting one",
)
assert.match(
  statusJob,
  /refusing to guess/,
  "an unreported require_install_smoke must fail rather than fall through",
)

// regen-drift must consume the same declaration. Its whole job is proving the
// committed tap matches a published release; while it is allowed to skip on
// "could not check", a launched tap could ship a stale formula unnoticed.
const regenJob = ci.match(/regen-drift:\n[\s\S]*?(?=\n  [a-z-]+:)/)?.[0]
assert.ok(regenJob, "regen-drift job must exist")
assert.match(
  regenJob,
  /publicInstallEnabled/,
  "regen-drift must read public-install.json, or a launched tap can ship a stale formula",
)
assert.match(regenJob, /skip_or_fail/)
assert.doesNotMatch(
  regenJob,
  /No published release\.json yet/,
  "'no access' and 'no published release' are different facts and must not share a message",
)
assert.match(
  regenJob,
  /this is an access fact, not a release fact/,
  "regen-drift must name a permissions failure as a permissions failure",
)

console.log("test-public-install-gate: OK")
