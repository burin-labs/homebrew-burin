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
  gitRefCreationRequest,
  producerRunIdFromBody,
  producerFailureReceipt,
  publishHarnFormula,
  sha256,
  upsertProducerRunMarker,
  validateProducerReceiptV2,
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
await test("live branch creation uses the Git refs API with exact identity", async () => {
  assert.equal(branchForRelease("v1.2.3"), "automation/harn-formula-v1.2.3")
  assert.notEqual(
    branchForRelease("v1.2.3").startsWith("automation/bump-harn-formula/"),
    true,
    "version branches must not be descendants of the legacy producer branch",
  )
  assert.deepEqual(
    gitRefCreationRequest(
      "burin-labs/homebrew-burin",
      "automation/harn-formula-v1.2.3",
      BASE_HEAD,
    ),
    {
      endpoint: "repos/burin-labs/homebrew-burin/git/refs",
      payload: {
        ref: "refs/heads/automation/harn-formula-v1.2.3",
        sha: BASE_HEAD,
      },
    },
  )
  assert.throws(
    () => gitRefCreationRequest("burin-labs/homebrew-burin", "automation/other", BASE_HEAD),
    /invalid version-qualified name/,
  )
  assert.throws(
    () => gitRefCreationRequest("burin-labs/homebrew-burin", "automation/harn-formula-v1.2.3", ""),
    /exact Git SHA/,
  )
})

await test("producer failures retain exact run identity in a typed receipt", async () => {
  assert.deepEqual(
    producerFailureReceipt({
      repository: "burin-labs/homebrew-burin",
      workflowRunId: 4242,
      requestedVersion: "v1.2.3",
      error: new Error("Ref cannot be created."),
    }),
    {
      schema_version: "homebrew_burin.harn_formula_failure.v1",
      state: "failed",
      repository: "burin-labs/homebrew-burin",
      workflow_run_id: 4242,
      requested_version: "v1.2.3",
      error: {message: "Ref cannot be created."},
    },
  )
})

await test("positive control publishes and proves one exact GitHub-signed head", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  const receipt = await publishHarnFormula({manifest, workflowRunId: 4242, adapter, checkAttempts: 1})

  assert.equal(adapter.createdBranches.length, 1)
  assert.deepEqual(adapter.commitLeases, [{branch: branchForRelease("v1.2.3"), expectedHead: BASE_HEAD}])
  assert.equal(receipt.schema_version, "homebrew_burin.harn_formula_producer.v2")
  assert.equal(receipt.repository, "burin-labs/homebrew-burin")
  assert.equal(receipt.release_tag, "v1.2.3")
  assert.equal(receipt.assets.length, 4)
  assert(receipt.assets.every((asset) => asset.name && /^[0-9a-f]{64}$/.test(asset.sha256)))
  assert.equal(receipt.formula_path, "Formula/harn.rb")
  assert.equal(receipt.formula_sha256, sha256(renderHarnFormula(manifest)))
  assert.equal(receipt.workflow_run_id, 4242)
  assert.equal(receipt.base_branch, "main")
  assert.equal(receipt.base_head_sha, BASE_HEAD)
  assert.equal(receipt.branch, "automation/harn-formula-v1.2.3")
  assert.equal(receipt.head_sha, SIGNED_HEAD)
  assert.deepEqual(receipt.pull_request, {
    number: 73,
    url: "https://github.com/burin-labs/homebrew-burin/pull/73",
    base_ref: "main",
    base_sha: BASE_HEAD,
    head_ref: "automation/harn-formula-v1.2.3",
    head_sha: SIGNED_HEAD,
    is_draft: false,
  })
  assert.deepEqual(receipt.signature, {
    head_sha: SIGNED_HEAD,
    is_valid: true,
    was_signed_by_github: true,
    state: "VALID",
  })
  assert.deepEqual(receipt.checks, {
    observation_state: "observed",
    total_count: 2,
    pending_count: 1,
    failing_count: 0,
    failing_names: [],
    head_sha: SIGNED_HEAD,
    contexts: [
      {kind: "check_run", name: "CI status", status: "COMPLETED", conclusion: "SUCCESS"},
      {kind: "check_run", name: "Tap checks (ubuntu)", status: "IN_PROGRESS", conclusion: null},
    ],
  })
  assert.equal(producerRunIdFromBody(adapter.pull.body), 4242)
  assert.equal(receipt.merge_commit_sha, null)
  assert.equal(receipt.post_merge_formula_sha256, null)
})

await test("valid v2 evidence fails closed under identity mutations", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  const receipt = await publishHarnFormula({manifest, workflowRunId: 4242, adapter, checkAttempts: 1})
  const expected = receiptExpectations(manifest, 4242)
  assert.equal(validateProducerReceiptV2(receipt, expected), receipt)

  const mutations = [
    ["repository", (copy) => { copy.repository = "burin-labs/another-tap" }, /repository mismatch/],
    ["workflow run", (copy) => { copy.workflow_run_id += 1 }, /workflow run mismatch/],
    ["release tag", (copy) => { copy.release_tag = "v1.2.4" }, /release tag mismatch/],
    ["base head", (copy) => { copy.base_head_sha = "b".repeat(40) }, /base head mismatch/],
    ["coupled receipt and PR base", (copy) => {
      copy.base_head_sha = "b".repeat(40)
      copy.pull_request.base_sha = "b".repeat(40)
    }, /base head mismatch/],
    ["candidate branch", (copy) => { copy.branch = "automation/other" }, /candidate branch mismatch/],
    ["candidate head", (copy) => { copy.head_sha = "b".repeat(40) }, /pull request identity mismatch/],
    ["PR number", (copy) => { copy.pull_request.number += 1 }, /pull request identity mismatch/],
    ["PR URL", (copy) => { copy.pull_request.url = "https://github.com/burin-labs/homebrew-burin/pull/74" }, /pull request identity mismatch/],
    ["PR base", (copy) => { copy.pull_request.base_ref = "release" }, /pull request identity mismatch/],
    ["PR head", (copy) => { copy.pull_request.head_sha = "b".repeat(40) }, /pull request identity mismatch/],
    ["PR draft", (copy) => { copy.pull_request.is_draft = true }, /pull request identity mismatch/],
    ["signature head", (copy) => { copy.signature.head_sha = "b".repeat(40) }, /signature identity mismatch/],
    ["signature validity", (copy) => { copy.signature.is_valid = false }, /signature identity mismatch/],
    ["GitHub signature", (copy) => { copy.signature.was_signed_by_github = false }, /signature identity mismatch/],
    ["signature state", (copy) => { copy.signature.state = "" }, /signature identity mismatch/],
    ["checks head", (copy) => { copy.checks.head_sha = "b".repeat(40) }, /check inventory mismatch/],
    ["checks total", (copy) => { copy.checks.total_count += 1 }, /check inventory mismatch/],
    ["duplicate check", (copy) => { copy.checks.contexts[1].name = copy.checks.contexts[0].name }, /duplicate PR check observation/],
    ["formula digest", (copy) => { copy.formula_sha256 = "f".repeat(64) }, /formula digest mismatch/],
    ["asset count", (copy) => { copy.assets.pop() }, /exactly 4 assets/],
    ["asset name", (copy) => { copy.assets[0].name = "other.tar.gz" }, /asset identity mismatch/],
    ["asset digest", (copy) => { copy.assets[0].sha256 = "f".repeat(64) }, /asset identity mismatch/],
  ]
  for (const [name, mutate, pattern] of mutations) {
    const copy = structuredClone(receipt)
    mutate(copy)
    assert.throws(
      () => validateProducerReceiptV2(copy, expected),
      pattern,
      `${name} mutation must fail closed`,
    )
  }
})

await test("producer run marker is exact, unique, replaceable, and preserves prose", async () => {
  const original = "Human release context.\n"
  const first = upsertProducerRunMarker(original, 41)
  assert.equal(producerRunIdFromBody(first), 41)
  assert(first.startsWith(original))
  const rerun = upsertProducerRunMarker(first, 42)
  assert.equal(producerRunIdFromBody(rerun), 42)
  assert.equal((rerun.match(/harn-formula-producer-run/g) ?? []).length, 1)
  assert(rerun.startsWith(original))
  assert.throws(
    () => upsertProducerRunMarker(`${first}\n<!-- harn-formula-producer-run: 42 -->\n`, 43),
    /duplicate harn-formula-producer-run markers/,
  )
  assert.throws(
    () => upsertProducerRunMarker("Human\n<!-- harn-formula-producer-run: nope -->\n", 43),
    /must contain a positive integer/,
  )
  assert.throws(
    () => upsertProducerRunMarker("Human harn-formula-producer-run: 41", 43),
    /malformed harn-formula-producer-run marker/,
  )
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
  adapter.wrongBranchName = "automation/harn-formula-v9.9.9"
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

await test("base movement during check polling cannot rewrite the projected producer base", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.moveBaseAfterCommit = true
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 43, adapter, checkAttempts: 1}),
    /producer pull request #73 base identity does not match/,
  )
  assert.deepEqual(adapter.projectionReads.map(({baseHead}) => baseHead), [BASE_HEAD, BASE_HEAD])
  assert.equal(adapter.pullRequestBodyUpdates.length, 0)
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

await test("recovery accepts the exact signed formula-only producer head", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.seedTargetBranch({formula: renderHarnFormula(manifest), signed: true})
  const receipt = await publishHarnFormula({
    manifest,
    workflowRunId: 51,
    adapter,
    checkAttempts: 1,
  })
  assert.equal(receipt.head_sha, SIGNED_HEAD)
  assert.equal(adapter.createdBranches.length, 0)
  assert.equal(adapter.commitLeases.length, 0)
  assert.equal(adapter.projectionReads.length, 2)
})

await test("a producer rerun replaces the exact PR marker through the live publishing path", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.seedTargetBranch({formula: renderHarnFormula(manifest), signed: true})
  adapter.pull = adapter.pullFixture({
    headSha: SIGNED_HEAD,
    body: upsertProducerRunMarker("Existing human release context.\n", 41),
  })
  const receipt = await publishHarnFormula({
    manifest,
    workflowRunId: 42,
    adapter,
    checkAttempts: 1,
  })
  assert.equal(receipt.workflow_run_id, 42)
  assert.equal(producerRunIdFromBody(adapter.pull.body), 42)
  assert.equal(adapter.pullRequestBodyUpdates.length, 1)
  assert(adapter.pull.body.startsWith("Existing human release context.\n"))
  assert.equal((adapter.pull.body.match(/harn-formula-producer-run/g) ?? []).length, 1)
})

await test("marker recovery refuses a pull request without its exact node identity", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.seedTargetBranch({formula: renderHarnFormula(manifest), signed: true})
  adapter.pull = adapter.pullFixture({headSha: SIGNED_HEAD})
  delete adapter.pull.id
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 42, adapter, checkAttempts: 1}),
    /producer pull request #73 node identity is missing/,
  )
})

await test("recovery rejects a signed matching formula with unrelated changes", async () => {
  const manifest = fixtureManifest()
  const adapter = new FakeAdapter(manifest)
  adapter.seedTargetBranch({formula: renderHarnFormula(manifest), signed: true})
  adapter.projectionFiles = [
    {path: "Formula/harn.rb", status: "modified"},
    {path: "README.md", status: "modified"},
  ]
  await rejectsNamed(
    publishHarnFormula({manifest, workflowRunId: 52, adapter, checkAttempts: 1}),
    /is not the exact formula-only projection.*changed files are not exactly modified Formula\/harn\.rb/,
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
  assert.match(workflow, /permission-contents: write/)
  assert.match(workflow, /permission-pull-requests: write/)
  assert.match(workflow, /permission-workflows: write/)
  assert.match(workflow, /version:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/)
  assert.match(
    workflow,
    /name: Upload typed producer receipt[\s\S]*?path: \$\{\{ runner\.temp \}\}\/harn-formula-receipt\.json[\s\S]*?if-no-files-found: error/,
  )
  assert.doesNotMatch(workflow, /if-no-files-found: ignore/)
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

function receiptExpectations(manifest, workflowRunId) {
  return {
    repository: "burin-labs/homebrew-burin",
    workflowRunId,
    manifest,
    formulaSha256: sha256(renderHarnFormula(manifest)),
    baseBranch: "main",
    baseHead: BASE_HEAD,
  }
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
    this.pullRequestBodyUpdates = []
    this.projectionReads = []
    this.projectionFiles = [{path: "Formula/harn.rb", status: "modified"}]
    this.otherBranches = new Map()
    this.assetDigests = new Map(manifest.assets.map((asset) => [asset.url, asset.sha256]))
    this.createdPullChecks = PASSING_CHECKS
    this.dropCreatedPull = false
    this.rejectLease = false
    this.moveAfterCommit = false
    this.moveBaseAfterCommit = false
    this.wrongBranchName = null
    this.onCreateBranch = null
  }

  async assetSha256(url) {
    return this.assetDigests.get(url)
  }

  async observe() {
    let branch = this.branch ? structuredClone(this.branch) : null
    let baseHead = BASE_HEAD
    let pull = this.pull ? structuredClone(this.pull) : null
    if (branch && this.wrongBranchName) branch.name = this.wrongBranchName
    if (branch && this.moveAfterCommit && this.commitLeases.length > 0) {
      branch.head_sha = MOVED_HEAD
    }
    if (this.moveBaseAfterCommit && this.commitLeases.length > 0) {
      baseHead = MOVED_HEAD
      if (pull) pull.base_sha = MOVED_HEAD
    }
    return {
      repository_id: "repository-id",
      base: {head_sha: baseHead, formula: this.baseFormula},
      branch,
      pull_requests: pull ? [pull] : [],
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

  async candidateProjection({baseHead, headSha}) {
    this.projectionReads.push({baseHead, headSha})
    return {
      base_head: baseHead,
      merge_base_head: baseHead,
      head_sha: headSha,
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      commit_shas: [headSha],
      files: structuredClone(this.projectionFiles),
    }
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

  async createPullRequest({body}) {
    if (!this.dropCreatedPull) {
      this.pull = this.pullFixture({
        headSha: this.branch.head_sha,
        checks: this.createdPullChecks,
        body,
      })
    }
  }

  async updatePullRequestBody({pullRequestId, body}) {
    assert.equal(pullRequestId, this.pull.id)
    this.pullRequestBodyUpdates.push({pullRequestId, body})
    this.pull.body = body
  }

  pullFixture({
    headSha,
    autoMergeArmed = false,
    checks = PASSING_CHECKS,
    state = "OPEN",
    merged = false,
    mergeCommitSha = null,
    postMergeFormulaSha256 = null,
    body = "Existing human release context.\n",
  }) {
    return {
      id: "PR_node_73",
      number: 73,
      url: "https://github.com/burin-labs/homebrew-burin/pull/73",
      body,
      state,
      is_draft: false,
      merged,
      base_ref: "main",
      base_sha: BASE_HEAD,
      head_ref: this.targetBranch,
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
