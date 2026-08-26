#!/usr/bin/env node
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  harnReleaseManifest,
  renderHarnFormula,
  validateHarnReleaseManifest,
} from "./update-harn-from-release.mjs"
import {
  branchForRelease,
  checkSummary,
  publishHarnFormula,
  sha256,
} from "./publish-harn-formula.mjs"

const BASE_HEAD = "a".repeat(40)
const SIGNED_HEAD = "c".repeat(40)
const MOVED_HEAD = "d".repeat(40)
const OLD_FORMULA = "class Harn < Formula\n  version \"1.2.2\"\nend\n"
const PASSING_CHECKS = [
  {kind: "check_run", name: "CI status", status: "COMPLETED", conclusion: "SUCCESS"},
  {kind: "check_run", name: "Tap checks (ubuntu)", status: "IN_PROGRESS", conclusion: null},
]

let tests = 0

async function main() {
await test("positive control publishes and proves one exact GitHub-signed head", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  const receipt = await publishHarnFormula({manifest, workflowRunId: 4242, adapter, checkAttempts: 1})

  assert.equal(adapter.createdBranches.length, 1)
  assert.deepEqual(adapter.commitLeases, [{branch: branchForRelease("v1.2.3"), expectedHead: BASE_HEAD}])
  assert.equal(receipt.schema_version, 1)
  assert.equal(receipt.release_tag, "v1.2.3")
  assert.equal(receipt.assets.length, 4)
  assert(receipt.assets.every((asset) => asset.name && /^[0-9a-f]{64}$/.test(asset.sha256)))
  assert.equal(receipt.formula_sha256, sha256(renderHarnFormula(manifest)))
  assert.equal(receipt.workflow_run_id, 4242)
  assert.equal(receipt.branch, "automation/bump-harn-formula/v1.2.3")
  assert.equal(receipt.head_sha, SIGNED_HEAD)
  assert.equal(receipt.pull_request_number, 73)
  assert.equal(receipt.pull_request_url, "https://github.com/burin-labs/homebrew-burin/pull/73")
  assert.deepEqual(receipt.checks, {
    observation_state: "observed",
    total_count: 2,
    pending_count: 1,
    failing_count: 0,
    failing_names: [],
  })
  assert.equal(receipt.merge_commit_sha, null)
  assert.equal(receipt.post_merge_formula_sha256, null)
})

await test("wrong asset count fails before publication", async () => {
  const malformed = structuredClone(fixtureManifest())
  malformed.assets.pop()
  assert.throws(
    () => validateHarnReleaseManifest(malformed),
    /must contain exactly 4 supported assets/,
  )
})

await test("download digest mismatch fails before publication", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.assetDigests.set(manifest.assets[2].url, "f".repeat(64))
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 1, adapter}),
    /harn-aarch64-unknown-linux-gnu\.tar\.gz digest mismatch/,
  )
  assert.equal(adapter.commitLeases.length, 0)
})

await test("stale exact-head lease fails by name", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.rejectLease = true
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 2, adapter}),
    /exact-head lease rejected formula publication: branch moved/,
  )
})

await test("wrong branch observation fails by name", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.wrongBranchName = "automation/bump-harn-formula/v9.9.9"
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 3, adapter}),
    /wrong branch observed/,
  )
})

await test("moved published head fails by name", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.moveAfterCommit = true
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 4, adapter}),
    /published branch head moved/,
  )
})

await test("unsigned exact head fails by name", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.seedTargetBranch({formula: renderHarnFormula(manifest), signed: false})
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 5, adapter, checkAttempts: 1}),
    /is not GitHub server-signed/,
  )
})

await test("armed pull request cannot be rewritten", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.seedTargetBranch({headSha: BASE_HEAD, formula: OLD_FORMULA, signed: true})
  adapter.pull = adapter.pullFixture({headSha: BASE_HEAD, autoMergeArmed: true})
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 6, adapter}),
    /refusing to rewrite armed pull request #73/,
  )
  assert.equal(adapter.commitLeases.length, 0)
})

await test("missing pull request observation fails by name", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.dropCreatedPull = true
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 7, adapter, checkAttempts: 1}),
    /missing pull request observation/,
  )
})

await test("missing check observations fail by name", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.createdPullChecks = []
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 8, adapter, checkAttempts: 1}),
    /missing PR check observations/,
  )
})

await test("a newer release arriving mid-run gets a distinct branch", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  const newerBranch = branchForRelease("v1.2.4")
  adapter.onCreateBranch = () => {
    adapter.otherBranches.set(newerBranch, {head_sha: "e".repeat(40), formula: "newer"})
  }
  await publishHarnFormula({manifest, workflowRunId: 9, adapter, checkAttempts: 1})
  assert.equal(adapter.otherBranches.get(newerBranch).head_sha, "e".repeat(40))
  assert.deepEqual(adapter.commitLeases.map((entry) => entry.branch), [branchForRelease("v1.2.3")])
})

await test("already-published target has explicit terminal lifecycle fields", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.baseFormula = renderHarnFormula(manifest)
  const receipt = await publishHarnFormula({manifest, workflowRunId: 10, adapter})
  assert.equal(receipt.state, "already_published")
  assert.equal(receipt.checks.observation_state, "not_applicable")
  assert.equal(receipt.merge_commit_sha, BASE_HEAD)
  assert.equal(receipt.post_merge_formula_sha256, receipt.formula_sha256)
  assert.equal(adapter.commitLeases.length, 0)
})

await test("failing check names stay visible beside totals", async () => {
  assert.deepEqual(checkSummary([
    {kind: "check_run", name: "good", status: "COMPLETED", conclusion: "SUCCESS"},
    {kind: "check_run", name: "bad", status: "COMPLETED", conclusion: "FAILURE"},
    {kind: "status_context", name: "waiting", state: "PENDING"},
  ]), {
    observation_state: "observed",
    total_count: 3,
    pending_count: 1,
    failing_count: 1,
    failing_names: ["bad"],
  })
})

await test("a rerun completes the receipt after the exact PR merges", async () => {
  const manifest = fixtureManifest()
  const formula = renderHarnFormula(manifest)
  const adapter = new FakeAdapter(manifest)
  adapter.baseFormula = formula
  adapter.seedTargetBranch({formula, signed: true})
  adapter.pull = adapter.pullFixture({
    headSha: SIGNED_HEAD,
    state: "MERGED",
    merged: true,
    mergeCommitSha: "f".repeat(40),
    postMergeFormulaSha256: sha256(formula),
  })
  const receipt = await publishHarnFormula({manifest, workflowRunId: 11, adapter})
  assert.equal(receipt.state, "merged")
  assert.equal(receipt.merge_commit_sha, "f".repeat(40))
  assert.equal(receipt.post_merge_formula_sha256, receipt.formula_sha256)
})

await test("workflow establishes the App identity before checkout and has no force push", async () => {
  const workflow = readFileSync(".github/workflows/bump-harn-formula.yml", "utf8")
  const tokenStep = workflow.indexOf("name: Mint GitHub App token")
  const checkoutStep = workflow.indexOf("name: Checkout with publishing identity")
  assert(tokenStep >= 0 && checkoutStep > tokenStep)
  assert.match(workflow, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}/)
  assert.match(workflow, /version:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/)
  assert.doesNotMatch(workflow, /git push|force-with-lease|force: true/)
})

console.log(`test-publish-harn-formula: OK (${tests} tests)`)
}

async function test(_name, run) {
  await run()
  tests += 1
}

async function rejectsNamed(promise, pattern) {
  await assert.rejects(promise, pattern)
}

function fixtureManifest(tag = "v1.2.3") {
  return harnReleaseManifest({
    tagName: tag,
    assets: [
      asset(tag, "harn-aarch64-apple-darwin.tar.gz", "1"),
      asset(tag, "harn-x86_64-apple-darwin.tar.gz", "2"),
      asset(tag, "harn-aarch64-unknown-linux-gnu.tar.gz", "3"),
      asset(tag, "harn-x86_64-unknown-linux-gnu.tar.gz", "4"),
      asset(tag, "harn-x86_64-pc-windows-msvc.zip", "5"),
    ],
  })
}

function asset(tag, name, digestChar) {
  return {
    name,
    digest: `sha256:${digestChar.repeat(64)}`,
    browser_download_url: `https://github.com/burin-labs/harn/releases/download/${tag}/${name}`,
  }
}

class FakeAdapter {
  constructor(manifest) {
    this.manifest = manifest
    this.baseFormula = OLD_FORMULA
    this.targetBranch = branchForRelease(manifest.release_tag)
    this.branch = null
    this.pull = null
    this.createdBranches = []
    this.commitLeases = []
    this.otherBranches = new Map()
    this.assetDigests = new Map(manifest.assets.map((asset) => [asset.url, asset.sha256]))
    this.createdPullChecks = PASSING_CHECKS
    this.dropCreatedPull = false
    this.rejectLease = false
    this.moveAfterCommit = false
    this.wrongBranchName = null
    this.onCreateBranch = null
  }

  async assetSha256(url) {
    return this.assetDigests.get(url)
  }

  async observe() {
    let branch = this.branch ? structuredClone(this.branch) : null
    if (branch && this.wrongBranchName) branch.name = this.wrongBranchName
    if (branch && this.moveAfterCommit && this.commitLeases.length > 0) {
      branch.head_sha = MOVED_HEAD
    }
    return {
      repository_id: "repository-id",
      base: {head_sha: BASE_HEAD, formula: this.baseFormula},
      branch,
      pull_requests: this.pull ? [structuredClone(this.pull)] : [],
    }
  }

  async createBranch({branch, baseHead}) {
    this.createdBranches.push({branch, baseHead})
    this.branch = {
      name: branch,
      head_sha: baseHead,
      formula: this.baseFormula,
      signature: {is_valid: true, was_signed_by_github: true, state: "VALID"},
    }
    this.onCreateBranch?.()
  }

  async commitFormula({branch, expectedHead, formula}) {
    this.commitLeases.push({branch, expectedHead})
    if (this.rejectLease) throw new Error("branch moved")
    assert.equal(this.branch.head_sha, expectedHead)
    this.branch = {
      name: branch,
      head_sha: SIGNED_HEAD,
      formula,
      signature: {is_valid: true, was_signed_by_github: true, state: "VALID"},
    }
    return SIGNED_HEAD
  }

  async createPullRequest() {
    if (!this.dropCreatedPull) {
      this.pull = this.pullFixture({headSha: this.branch.head_sha, checks: this.createdPullChecks})
    }
  }

  pullFixture({
    headSha,
    autoMergeArmed = false,
    checks = PASSING_CHECKS,
    state = "OPEN",
    merged = false,
    mergeCommitSha = null,
    postMergeFormulaSha256 = null,
  }) {
    return {
      number: 73,
      url: "https://github.com/burin-labs/homebrew-burin/pull/73",
      state,
      is_draft: false,
      merged,
      head_sha: headSha,
      auto_merge_armed: autoMergeArmed,
      merge_queue_armed: false,
      merge_commit_sha: mergeCommitSha,
      post_merge_formula_sha256: postMergeFormulaSha256,
      check_contexts: structuredClone(checks),
    }
  }

  seedTargetBranch({headSha = SIGNED_HEAD, formula, signed}) {
    this.branch = {
      name: this.targetBranch,
      head_sha: headSha,
      formula,
      signature: {is_valid: signed, was_signed_by_github: signed, state: signed ? "VALID" : "UNKNOWN_KEY"},
    }
  }

  async wait() {}
}

await main()
