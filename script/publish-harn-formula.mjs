#!/usr/bin/env node
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"

import {
  HARN_RELEASE_ASSETS,
  harnReleaseManifest,
  renderHarnFormula,
  validateHarnReleaseManifest,
} from "./update-harn-from-release.mjs"

const FORMULA_PATH = "Formula/harn.rb"
const BRANCH_ROOT = "automation/bump-harn-formula"
const SHA256 = /^[0-9a-f]{64}$/
const GIT_SHA = /^[0-9a-f]{40}$/
const PRODUCER_RECEIPT_SCHEMA = "homebrew_burin.harn_formula_producer.v2"
const PRODUCER_RUN_MARKER_NAME = "harn-formula-producer-run"
const PRODUCER_RUN_MARKER = /<!--\s*harn-formula-producer-run\s*:\s*([^]*?)\s*-->/g

export function branchForRelease(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`release tag must look like vX.Y.Z, got ${tag}`)
  }
  return `${BRANCH_ROOT}/${tag}`
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizedCheckContexts(contexts) {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    throw new Error("missing PR check observations")
  }
  const seen = new Set()
  const normalized = contexts.map((context) => {
    const name = String(context?.name ?? "").trim()
    if (!name) throw new Error("PR check observation is missing its name")
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error(`duplicate PR check observation ${name}`)
    seen.add(key)
    if (context.kind === "check_run") {
      const status = String(context.status ?? "").trim()
      if (!status) throw new Error(`PR check ${name} is missing its status`)
      const conclusion = context.conclusion === null || context.conclusion === undefined
        ? null
        : String(context.conclusion).trim()
      if (conclusion === "") throw new Error(`PR check ${name} has an empty conclusion`)
      return {kind: "check_run", name, status, conclusion}
    }
    if (context.kind === "status_context") {
      const state = String(context.state ?? "").trim()
      if (!state) throw new Error(`PR status ${name} is missing its state`)
      return {kind: "status_context", name, state}
    }
    throw new Error(`PR check ${name} has unknown kind`)
  })
  return normalized.sort((left, right) => (
    left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind)
  ))
}

function summaryForNormalizedChecks(contexts) {
  const failingNames = []
  let pendingCount = 0
  for (const context of contexts) {
    const {name} = context
    if (context.kind === "check_run") {
      if (context.status !== "COMPLETED") {
        pendingCount += 1
      } else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion)) {
        failingNames.push(name)
      }
    } else if (context.kind === "status_context") {
      if (["PENDING", "EXPECTED"].includes(context.state)) {
        pendingCount += 1
      } else if (context.state !== "SUCCESS") {
        failingNames.push(name)
      }
    }
  }
  return {
    observation_state: "observed",
    total_count: contexts.length,
    pending_count: pendingCount,
    failing_count: failingNames.length,
    failing_names: failingNames.sort(),
  }
}

export function checkSummary(contexts) {
  return summaryForNormalizedChecks(normalizedCheckContexts(contexts))
}

export function checkInventory(contexts, headSha) {
  if (!GIT_SHA.test(headSha ?? "")) {
    throw new Error("PR check inventory is missing its exact head SHA")
  }
  const normalized = normalizedCheckContexts(contexts)
  return {
    ...summaryForNormalizedChecks(normalized),
    head_sha: headSha,
    contexts: normalized,
  }
}

function producerRunMarker(workflowRunId) {
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
    throw new Error("producer workflow run ID must be a positive integer")
  }
  return `<!-- ${PRODUCER_RUN_MARKER_NAME}: ${workflowRunId} -->`
}

function producerRunMarkerMatches(body) {
  PRODUCER_RUN_MARKER.lastIndex = 0
  return [...String(body ?? "").matchAll(PRODUCER_RUN_MARKER)]
}

export function producerRunIdFromBody(body) {
  const source = String(body ?? "")
  const matches = producerRunMarkerMatches(source)
  if (matches.length !== 1) {
    throw new Error(`pull request must contain exactly one ${PRODUCER_RUN_MARKER_NAME} marker`)
  }
  if (!/^[1-9]\d*$/.test(matches[0][1].trim())) {
    throw new Error(`${PRODUCER_RUN_MARKER_NAME} marker must contain a positive integer`)
  }
  const runId = Number(matches[0][1].trim())
  if (!Number.isSafeInteger(runId)) {
    throw new Error(`${PRODUCER_RUN_MARKER_NAME} marker exceeds the safe integer range`)
  }
  return runId
}

export function upsertProducerRunMarker(body, workflowRunId) {
  const source = String(body ?? "")
  const marker = producerRunMarker(workflowRunId)
  const matches = producerRunMarkerMatches(source)
  if (matches.length > 1) {
    throw new Error(`pull request contains duplicate ${PRODUCER_RUN_MARKER_NAME} markers`)
  }
  if (matches.length === 1) {
    producerRunIdFromBody(source)
    return source.replace(matches[0][0], marker)
  }
  if (source.includes(PRODUCER_RUN_MARKER_NAME)) {
    throw new Error(`pull request contains a malformed ${PRODUCER_RUN_MARKER_NAME} marker`)
  }
  return `${source.trimEnd()}\n\n${marker}\n`
}

function exactPullRequest(observation, headSha) {
  const pulls = observation.pull_requests ?? []
  const open = pulls.filter((pull) => pull.state === "OPEN")
  if (open.length > 1) {
    throw new Error(`branch has ${open.length} open pull requests; expected at most one`)
  }
  return open.find((pull) => pull.head_sha === headSha)
    ?? pulls.find((pull) => pull.merged && pull.head_sha === headSha)
    ?? null
}

function assertExactBranch(observation, branch) {
  if (observation.branch && observation.branch.name !== branch) {
    throw new Error(
      `wrong branch observed: expected ${branch}, got ${observation.branch.name}`,
    )
  }
}

function assertExactSignedHead(observation, branch, headSha, formulaSha256) {
  assertExactBranch(observation, branch)
  if (!observation.branch) {
    throw new Error(`published branch ${branch} is missing`)
  }
  if (observation.branch.head_sha !== headSha) {
    throw new Error(
      `published branch head moved: expected ${headSha}, got ${observation.branch.head_sha}`,
    )
  }
  if (sha256(observation.branch.formula ?? "") !== formulaSha256) {
    throw new Error(`published branch ${branch} formula digest mismatch`)
  }
  const signature = observation.branch.signature
  if (!signature?.is_valid || !signature?.was_signed_by_github) {
    throw new Error(`published head ${headSha} is not GitHub server-signed`)
  }
  if (!String(signature.state ?? "").trim()) {
    throw new Error(`published head ${headSha} signature state is missing`)
  }
  return {
    head_sha: headSha,
    is_valid: true,
    was_signed_by_github: true,
    state: String(signature.state).trim(),
  }
}

function assertExactPullRequestIdentity({pull, repository, baseBranch, branch, headSha}) {
  if (!Number.isSafeInteger(pull?.number) || pull.number <= 0) {
    throw new Error("producer pull request number is missing")
  }
  if (pull.url !== `https://github.com/${repository}/pull/${pull.number}`) {
    throw new Error(`producer pull request #${pull.number} URL does not match its repository`)
  }
  if (pull.base_ref !== baseBranch || !GIT_SHA.test(pull.base_sha ?? "")) {
    throw new Error(`producer pull request #${pull.number} base identity does not match`)
  }
  if (pull.head_ref !== branch || pull.head_sha !== headSha) {
    throw new Error(`producer pull request #${pull.number} head identity does not match`)
  }
  if (pull.is_draft) {
    throw new Error(`producer pull request #${pull.number} is draft; expected READY`)
  }
  return {
    number: pull.number,
    url: pull.url,
    base_ref: pull.base_ref,
    base_sha: pull.base_sha,
    head_ref: pull.head_ref,
    head_sha: pull.head_sha,
    is_draft: false,
  }
}

function assertExactFormulaProjection(projection, baseHead, headSha) {
  const failures = []
  if (projection?.base_head !== baseHead) failures.push("base head differs")
  if (projection?.merge_base_head !== baseHead) failures.push("merge base differs")
  if (projection?.head_sha !== headSha) failures.push("candidate head differs")
  if (projection?.status !== "ahead") failures.push(`status is ${projection?.status ?? "missing"}`)
  if (projection?.ahead_by !== 1) failures.push(`ahead_by is ${projection?.ahead_by ?? "missing"}`)
  if (projection?.behind_by !== 0) failures.push(`behind_by is ${projection?.behind_by ?? "missing"}`)
  if (projection?.total_commits !== 1) {
    failures.push(`total_commits is ${projection?.total_commits ?? "missing"}`)
  }
  if (
    !Array.isArray(projection?.commit_shas)
    || projection.commit_shas.length !== 1
    || projection.commit_shas[0] !== headSha
  ) {
    failures.push("commit lineage is not the exact candidate")
  }
  if (
    !Array.isArray(projection?.files)
    || projection.files.length !== 1
    || projection.files[0]?.path !== FORMULA_PATH
    || projection.files[0]?.status !== "modified"
  ) {
    failures.push("changed files are not exactly modified Formula/harn.rb")
  }
  if (failures.length > 0) {
    throw new Error(
      `candidate head ${headSha} is not the exact formula-only projection from ${baseHead}: ${failures.join(", ")}`,
    )
  }
}

async function assertExactProducerHead({
  observation,
  adapter,
  repository,
  branch,
  baseHead,
  headSha,
  formulaSha256,
}) {
  assertExactSignedHead(observation, branch, headSha, formulaSha256)
  const projection = await adapter.candidateProjection({repository, baseHead, headSha})
  assertExactFormulaProjection(projection, baseHead, headSha)
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function requireReceiptSha(value, field) {
  if (!GIT_SHA.test(value ?? "")) throw new Error(`${field} must be an exact Git SHA`)
}

function requireReceiptSha256(value, field) {
  if (!SHA256.test(value ?? "")) throw new Error(`${field} must be a SHA-256 digest`)
}

/** Closed producer boundary used for both artifact assembly and mutation controls. */
export function validateProducerReceiptV2(receipt, expected) {
  if (receipt?.schema_version !== PRODUCER_RECEIPT_SCHEMA) {
    throw new Error(`producer receipt schema_version must be ${PRODUCER_RECEIPT_SCHEMA}`)
  }
  if (receipt.repository !== expected.repository) throw new Error("producer receipt repository mismatch")
  if (receipt.workflow_run_id !== expected.workflowRunId) {
    throw new Error("producer receipt workflow run mismatch")
  }
  if (receipt.release_tag !== expected.manifest.release_tag) {
    throw new Error("producer receipt release tag mismatch")
  }
  if (receipt.formula_path !== FORMULA_PATH) throw new Error("producer receipt formula path mismatch")
  requireReceiptSha256(receipt.formula_sha256, "producer receipt formula_sha256")
  if (receipt.formula_sha256 !== expected.formulaSha256) {
    throw new Error("producer receipt formula digest mismatch")
  }
  if (receipt.base_branch !== expected.baseBranch) throw new Error("producer receipt base branch mismatch")
  requireReceiptSha(receipt.base_head_sha, "producer receipt base_head_sha")
  if (receipt.branch !== branchForRelease(expected.manifest.release_tag)) {
    throw new Error("producer receipt candidate branch mismatch")
  }
  if (!Array.isArray(receipt.assets) || receipt.assets.length !== HARN_RELEASE_ASSETS.length) {
    throw new Error(`producer receipt must contain exactly ${HARN_RELEASE_ASSETS.length} assets`)
  }
  const expectedAssets = expected.manifest.assets.map(({name, sha256: digest}) => ({name, sha256: digest}))
  for (const asset of receipt.assets) requireReceiptSha256(asset?.sha256, `asset ${asset?.name ?? ""}`)
  if (!equalJson(receipt.assets, expectedAssets)) throw new Error("producer receipt asset identity mismatch")

  if (receipt.state === "already_published") {
    if (receipt.head_sha !== receipt.base_head_sha) {
      throw new Error("already-published producer receipt head does not match main")
    }
    if (receipt.pull_request !== null || receipt.signature !== null) {
      throw new Error("already-published producer receipt unexpectedly contains candidate identity")
    }
    const emptyChecks = {
      observation_state: "not_applicable",
      total_count: 0,
      pending_count: 0,
      failing_count: 0,
      failing_names: [],
      head_sha: receipt.head_sha,
      contexts: [],
    }
    if (!equalJson(receipt.checks, emptyChecks)) {
      throw new Error("already-published producer receipt check inventory mismatch")
    }
    if (
      receipt.merge_commit_sha !== receipt.base_head_sha ||
      receipt.post_merge_formula_sha256 !== receipt.formula_sha256
    ) {
      throw new Error("already-published producer receipt publication identity mismatch")
    }
    return receipt
  }
  if (!["pull_request_open", "merged"].includes(receipt.state)) {
    throw new Error(`producer receipt has unknown state ${receipt.state}`)
  }
  requireReceiptSha(receipt.head_sha, "producer receipt head_sha")
  const pull = receipt.pull_request
  if (
    !Number.isSafeInteger(pull?.number) ||
    pull.number <= 0 ||
    pull?.base_ref !== receipt.base_branch ||
    pull?.base_sha !== receipt.base_head_sha ||
    pull?.head_ref !== receipt.branch ||
    pull?.head_sha !== receipt.head_sha ||
    pull?.is_draft !== false ||
    pull?.url !== `https://github.com/${receipt.repository}/pull/${pull?.number}`
  ) {
    throw new Error("producer receipt pull request identity mismatch")
  }
  if (
    receipt.signature?.head_sha !== receipt.head_sha ||
    receipt.signature?.is_valid !== true ||
    receipt.signature?.was_signed_by_github !== true ||
    !String(receipt.signature?.state ?? "").trim()
  ) {
    throw new Error("producer receipt signature identity mismatch")
  }
  const rebuiltChecks = checkInventory(receipt.checks?.contexts, receipt.head_sha)
  if (!equalJson(receipt.checks, rebuiltChecks)) {
    throw new Error("producer receipt check inventory mismatch")
  }
  if (receipt.state === "merged") {
    requireReceiptSha(receipt.merge_commit_sha, "producer receipt merge_commit_sha")
    if (receipt.post_merge_formula_sha256 !== receipt.formula_sha256) {
      throw new Error("producer receipt post-merge formula digest mismatch")
    }
  } else if (receipt.merge_commit_sha !== null || receipt.post_merge_formula_sha256 !== null) {
    throw new Error("open producer receipt unexpectedly contains merge identity")
  }
  return receipt
}

function receiptFor({
  manifest,
  formulaSha256,
  workflowRunId,
  repository,
  baseBranch,
  branch,
  headSha,
  signature,
  pull,
}) {
  const pullRequest = assertExactPullRequestIdentity({
    pull,
    repository,
    baseBranch,
    branch,
    headSha,
  })
  if (producerRunIdFromBody(pull.body) !== workflowRunId) {
    throw new Error(`producer pull request #${pull.number} run marker mismatch`)
  }
  const receipt = {
    schema_version: PRODUCER_RECEIPT_SCHEMA,
    state: pull?.merged ? "merged" : "pull_request_open",
    repository,
    workflow_run_id: workflowRunId,
    release_tag: manifest.release_tag,
    assets: manifest.assets.map(({ name, sha256: digest }) => ({name, sha256: digest})),
    formula_path: FORMULA_PATH,
    formula_sha256: formulaSha256,
    base_branch: baseBranch,
    base_head_sha: pullRequest.base_sha,
    branch,
    head_sha: headSha,
    pull_request: pullRequest,
    signature,
    checks: checkInventory(pull.check_contexts, headSha),
    merge_commit_sha: pull.merge_commit_sha ?? null,
    post_merge_formula_sha256: pull.post_merge_formula_sha256 ?? null,
  }
  return validateProducerReceiptV2(receipt, {
    repository,
    workflowRunId,
    manifest,
    formulaSha256,
    baseBranch,
  })
}

async function verifyAssets(manifest, adapter) {
  const actual = await Promise.all(
    manifest.assets.map(async (asset) => ({
      name: asset.name,
      expected: asset.sha256,
      actual: await adapter.assetSha256(asset.url),
    })),
  )
  for (const asset of actual) {
    if (!SHA256.test(asset.actual)) {
      throw new Error(`downloaded asset ${asset.name} did not produce a SHA-256 digest`)
    }
    if (asset.actual !== asset.expected) {
      throw new Error(
        `release asset ${asset.name} digest mismatch: manifest ${asset.expected}, downloaded ${asset.actual}`,
      )
    }
  }
}

function pullRequestBody(manifest, workflowRunId) {
  return [
    `Regenerated \`${FORMULA_PATH}\` from the published \`${manifest.release_tag}\` release.`,
    "",
    "The producer downloaded and SHA-256 verified all four supported macOS/Linux archives before publishing this GitHub-signed exact-head commit.",
    "",
    "Opened by `.github/workflows/bump-harn-formula.yml`; this pull request remains unarmed for Fleet or a person to evaluate.",
    "",
    producerRunMarker(workflowRunId),
  ].join("\n")
}

async function ensureProducerRunMarker(adapter, pull, workflowRunId) {
  const current = String(pull?.body ?? "")
  const next = upsertProducerRunMarker(current, workflowRunId)
  if (next !== current) {
    if (!String(pull?.id ?? "").trim()) {
      throw new Error(`producer pull request #${pull?.number ?? "unknown"} node identity is missing`)
    }
    await adapter.updatePullRequestBody({pullRequestId: pull.id, body: next})
  }
  return next
}

export async function publishHarnFormula({
  manifest: inputManifest,
  workflowRunId,
  adapter,
  repository = "burin-labs/homebrew-burin",
  baseBranch = "main",
  checkAttempts = 20,
}) {
  const manifest = validateHarnReleaseManifest(inputManifest)
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
    throw new Error("workflow_run_id must be a positive integer")
  }
  const branch = branchForRelease(manifest.release_tag)
  const formula = renderHarnFormula(manifest)
  const formulaSha256 = sha256(formula)

  await verifyAssets(manifest, adapter)

  let observation = await adapter.observe({repository, baseBranch, branch})
  assertExactBranch(observation, branch)
  const baseHead = observation.base?.head_sha
  if (!/^[0-9a-f]{40}$/.test(baseHead ?? "")) {
    throw new Error(`missing exact ${baseBranch} head observation`)
  }
  if (typeof observation.base.formula !== "string") {
    throw new Error(`missing ${FORMULA_PATH} observation on ${baseBranch}@${baseHead}`)
  }
  if (sha256(observation.base.formula ?? "") === formulaSha256) {
    const publishedHead = observation.branch?.head_sha
    const mergedPull = publishedHead ? exactPullRequest(observation, publishedHead) : null
    if (mergedPull?.merged) {
      const signature = assertExactSignedHead(observation, branch, publishedHead, formulaSha256)
      if (mergedPull.post_merge_formula_sha256 !== formulaSha256) {
        throw new Error(`merged pull request #${mergedPull.number} formula digest mismatch`)
      }
      mergedPull.body = await ensureProducerRunMarker(adapter, mergedPull, workflowRunId)
      return receiptFor({
        manifest,
        formulaSha256,
        workflowRunId,
        repository,
        baseBranch,
        branch,
        headSha: publishedHead,
        signature,
        pull: mergedPull,
      })
    }
    const receipt = {
      schema_version: PRODUCER_RECEIPT_SCHEMA,
      state: "already_published",
      repository,
      workflow_run_id: workflowRunId,
      release_tag: manifest.release_tag,
      assets: manifest.assets.map(({ name, sha256: digest }) => ({name, sha256: digest})),
      formula_path: FORMULA_PATH,
      formula_sha256: formulaSha256,
      base_branch: baseBranch,
      base_head_sha: baseHead,
      branch,
      head_sha: baseHead,
      pull_request: null,
      signature: null,
      checks: {
        observation_state: "not_applicable",
        total_count: 0,
        pending_count: 0,
        failing_count: 0,
        failing_names: [],
        head_sha: baseHead,
        contexts: [],
      },
      merge_commit_sha: baseHead,
      post_merge_formula_sha256: formulaSha256,
    }
    return validateProducerReceiptV2(receipt, {
      repository,
      workflowRunId,
      manifest,
      formulaSha256,
      baseBranch,
    })
  }

  if (!observation.branch) {
    await adapter.createBranch({repository, repositoryId: observation.repository_id, branch, baseHead})
    observation = await adapter.observe({repository, baseBranch, branch})
    assertExactBranch(observation, branch)
    if (observation.branch?.head_sha !== baseHead) {
      throw new Error(
        `new branch head moved: expected ${baseHead}, got ${observation.branch?.head_sha ?? "missing"}`,
      )
    }
  }

  let headSha = observation.branch.head_sha
  const currentFormulaSha = sha256(observation.branch.formula ?? "")
  if (currentFormulaSha !== formulaSha256) {
    const openPull = (observation.pull_requests ?? []).find((pull) => pull.state === "OPEN")
    if (openPull?.auto_merge_armed || openPull?.merge_queue_armed) {
      throw new Error(`refusing to rewrite armed pull request #${openPull.number}`)
    }
    if (headSha !== baseHead) {
      throw new Error(
        `refusing to rewrite unexpected branch head ${headSha}; expected base ${baseHead}`,
      )
    }
    try {
      headSha = await adapter.commitFormula({
        repository,
        branch,
        expectedHead: headSha,
        formula,
        headline: `chore: update Harn formula to ${manifest.version}`,
      })
    } catch (error) {
      throw new Error(`exact-head lease rejected formula publication: ${error.message}`)
    }
  }

  observation = await adapter.observe({repository, baseBranch, branch})
  await assertExactProducerHead({
    observation,
    adapter,
    repository,
    branch,
    baseHead,
    headSha,
    formulaSha256,
  })

  let pull = exactPullRequest(observation, headSha)
  if (!pull) {
    await adapter.createPullRequest({
      repository,
      repositoryId: observation.repository_id,
      baseBranch,
      branch,
      title: `chore: update Harn formula to ${manifest.version}`,
      body: pullRequestBody(manifest, workflowRunId),
    })
  }

  for (let attempt = 1; attempt <= checkAttempts; attempt += 1) {
    observation = await adapter.observe({repository, baseBranch, branch})
    await assertExactProducerHead({
      observation,
      adapter,
      repository,
      branch,
      baseHead,
      headSha,
      formulaSha256,
    })
    pull = exactPullRequest(observation, headSha)
    if (!pull) {
      if (attempt === checkAttempts) {
        throw new Error(`missing pull request observation for ${branch}@${headSha}`)
      }
    } else if (pull.check_contexts?.length > 0) {
      const signature = assertExactSignedHead(observation, branch, headSha, formulaSha256)
      assertExactPullRequestIdentity({pull, repository, baseBranch, branch, headSha})
      pull.body = await ensureProducerRunMarker(adapter, pull, workflowRunId)
      if (pull.merged && !pull.post_merge_formula_sha256) {
        throw new Error(`merged pull request #${pull.number} is missing post-merge formula observation`)
      }
      return receiptFor({
        manifest,
        formulaSha256,
        workflowRunId,
        repository,
        baseBranch,
        branch,
        headSha,
        signature,
        pull,
      })
    } else if (attempt === checkAttempts) {
      throw new Error(`missing PR check observations for pull request #${pull.number}`)
    }
    await adapter.wait(attempt)
  }
  throw new Error("unreachable check observation state")
}

const OBSERVE_QUERY = `
query($owner: String!, $name: String!, $base: String!, $qualifiedBranch: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    id
    base: ref(qualifiedName: $base) {
      target { ... on Commit { oid formula: file(path: "${FORMULA_PATH}") { object { ... on Blob { text } } } } }
    }
    branch: ref(qualifiedName: $qualifiedBranch) {
      name
      target {
        ... on Commit {
          oid
          signature { isValid wasSignedByGitHub state }
          formula: file(path: "${FORMULA_PATH}") { object { ... on Blob { text } } }
          statusCheckRollup {
            contexts(first: 100) {
              totalCount
              nodes {
                __typename
                ... on CheckRun { name status conclusion }
                ... on StatusContext { context state }
              }
            }
          }
        }
      }
    }
    pullRequests(first: 20, states: [OPEN, MERGED, CLOSED], headRefName: $branch, baseRefName: $base, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id number url body state isDraft merged baseRefName baseRefOid headRefName headRefOid
        autoMergeRequest { enabledAt }
        mergeQueueEntry { id }
        mergeCommit { oid formula: file(path: "${FORMULA_PATH}") { object { ... on Blob { text } } } }
      }
    }
  }
}`

function splitRepository(repository) {
  const parts = repository.split("/")
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error(`repository must be owner/name, got ${repository}`)
  }
  return {owner: parts[0], name: parts[1]}
}

function blobText(entry) {
  return entry?.object?.text ?? null
}

function contextsFrom(target) {
  const connection = target?.statusCheckRollup?.contexts
  if (!connection) return []
  if (connection.totalCount !== connection.nodes.length) {
    throw new Error(`PR check observation truncated at ${connection.nodes.length}/${connection.totalCount}`)
  }
  return connection.nodes.map((node) => {
    if (node.__typename === "CheckRun") {
      return {kind: "check_run", name: node.name, status: node.status, conclusion: node.conclusion}
    }
    return {kind: "status_context", name: node.context, state: node.state}
  })
}

async function graphql(query, variables) {
  const response = await gh(["api", "graphql", "--input", "-"], {query, variables})
  if (response.errors?.length) {
    throw new Error(response.errors.map((error) => error.message).join("; "))
  }
  return response.data
}

async function gh(args, input = null) {
  return await new Promise((resolve, reject) => {
    const child = spawn("gh", args, {stdio: ["pipe", "pipe", "pipe"]})
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim()}`))
        return
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {})
      } catch (error) {
        reject(new Error(`gh returned invalid JSON: ${error.message}`))
      }
    })
    if (input) child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

export function liveGitHubAdapter() {
  return {
    async assetSha256(url) {
      const response = await fetch(url, {headers: {"User-Agent": "homebrew-burin-formula-producer"}})
      if (!response.ok || !response.body) {
        throw new Error(`asset download failed with HTTP ${response.status}: ${url}`)
      }
      const hash = createHash("sha256")
      for await (const chunk of response.body) hash.update(chunk)
      return hash.digest("hex")
    },

    async observe({repository, baseBranch, branch}) {
      const {owner, name} = splitRepository(repository)
      const data = await graphql(OBSERVE_QUERY, {
        owner,
        name,
        base: baseBranch,
        qualifiedBranch: `refs/heads/${branch}`,
        branch,
      })
      const repo = data.repository
      if (!repo) throw new Error(`repository ${repository} was not observed`)
      const baseTarget = repo.base?.target
      const branchTarget = repo.branch?.target
      return {
        repository_id: repo.id,
        base: baseTarget ? {head_sha: baseTarget.oid, formula: blobText(baseTarget.formula)} : null,
        branch: branchTarget ? {
          name: repo.branch.name,
          head_sha: branchTarget.oid,
          formula: blobText(branchTarget.formula),
          signature: branchTarget.signature ? {
            is_valid: branchTarget.signature.isValid,
            was_signed_by_github: branchTarget.signature.wasSignedByGitHub,
            state: branchTarget.signature.state,
          } : null,
        } : null,
        pull_requests: repo.pullRequests.nodes.map((pull) => ({
          id: pull.id,
          number: pull.number,
          url: pull.url,
          body: pull.body,
          state: pull.state,
          is_draft: pull.isDraft,
          merged: pull.merged,
          base_ref: pull.baseRefName,
          base_sha: pull.baseRefOid,
          head_ref: pull.headRefName,
          head_sha: pull.headRefOid,
          auto_merge_armed: pull.autoMergeRequest !== null,
          merge_queue_armed: pull.mergeQueueEntry !== null,
          merge_commit_sha: pull.mergeCommit?.oid ?? null,
          post_merge_formula_sha256: typeof blobText(pull.mergeCommit?.formula) === "string"
            ? sha256(blobText(pull.mergeCommit.formula))
            : null,
          check_contexts: pull.headRefOid === branchTarget?.oid ? contextsFrom(branchTarget) : [],
        })),
      }
    },

    async candidateProjection({repository, baseHead, headSha}) {
      const comparison = await gh([
        "api",
        `repos/${repository}/compare/${baseHead}...${headSha}`,
      ])
      return {
        base_head: comparison.base_commit?.sha ?? null,
        merge_base_head: comparison.merge_base_commit?.sha ?? null,
        head_sha: comparison.commits?.at(-1)?.sha ?? null,
        status: comparison.status ?? null,
        ahead_by: comparison.ahead_by ?? null,
        behind_by: comparison.behind_by ?? null,
        total_commits: comparison.total_commits ?? null,
        commit_shas: Array.isArray(comparison.commits)
          ? comparison.commits.map((commit) => commit.sha)
          : null,
        files: Array.isArray(comparison.files)
          ? comparison.files.map((file) => ({path: file.filename, status: file.status}))
          : null,
      }
    },

    async createBranch({repositoryId, branch, baseHead}) {
      const data = await graphql(
        "mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name target { oid } } } }",
        {input: {repositoryId, name: `refs/heads/${branch}`, oid: baseHead}},
      )
      const created = data.createRef?.ref
      if (created?.target?.oid !== baseHead) {
        throw new Error(`createRef returned an unexpected head for ${branch}`)
      }
    },

    async commitFormula({repository, branch, expectedHead, formula, headline}) {
      const data = await graphql(
        "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } ref { name target { oid } } } }",
        {
          input: {
            branch: {repositoryNameWithOwner: repository, branchName: branch},
            message: {headline},
            fileChanges: {additions: [{path: FORMULA_PATH, contents: Buffer.from(formula).toString("base64")}]},
            expectedHeadOid: expectedHead,
          },
        },
      )
      const result = data.createCommitOnBranch
      if (!result?.commit?.oid || result.ref?.target?.oid !== result.commit.oid) {
        throw new Error("createCommitOnBranch returned no exact updated head")
      }
      return result.commit.oid
    },

    async createPullRequest({repositoryId, baseBranch, branch, title, body}) {
      const data = await graphql(
        "mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number url isDraft headRefOid } } }",
        {input: {repositoryId, baseRefName: baseBranch, headRefName: branch, title, body, draft: false}},
      )
      if (!data.createPullRequest?.pullRequest?.number) {
        throw new Error(`pull request creation for ${branch} returned no pull request`)
      }
    },

    async updatePullRequestBody({pullRequestId, body}) {
      const data = await graphql(
        "mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { pullRequest { id body } } }",
        {input: {pullRequestId, body}},
      )
      if (
        data.updatePullRequest?.pullRequest?.id !== pullRequestId ||
        data.updatePullRequest?.pullRequest?.body !== body
      ) {
        throw new Error("updatePullRequest did not preserve the exact producer run marker")
      }
    },

    async wait(attempt) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 2000, 10000)))
    },
  }
}

function parseArgs(argv) {
  const out = {releaseJson: "", version: "", receipt: "", repository: "burin-labs/homebrew-burin"}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--release-json") out.releaseJson = argv[++i] ?? ""
    else if (arg === "--version") out.version = argv[++i] ?? ""
    else if (arg === "--receipt") out.receipt = argv[++i] ?? ""
    else if (arg === "--repository") out.repository = argv[++i] ?? ""
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.releaseJson || !out.version || !out.receipt) {
    throw new Error("--release-json, --version, and --receipt are required")
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const release = JSON.parse(readFileSync(args.releaseJson, "utf8"))
  const manifest = harnReleaseManifest(release)
  if (manifest.release_tag !== args.version) {
    throw new Error(
      `release payload tag ${manifest.release_tag} does not match requested ${args.version}`,
    )
  }
  const workflowRunId = Number(process.env.GITHUB_RUN_ID)
  const receipt = await publishHarnFormula({
    manifest,
    workflowRunId,
    adapter: liveGitHubAdapter(),
    repository: args.repository,
  })
  writeFileSync(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600})
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Formula producer: ${receipt.state}; ${receipt.branch}@${receipt.head_sha}; checks ${receipt.checks.total_count} total, ${receipt.checks.pending_count} pending, ${receipt.checks.failing_count} failing.\n`,
    )
  }
  process.stdout.write(`publish-harn-formula: ${receipt.state} ${receipt.head_sha}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`publish-harn-formula: ${error.message}\n`)
    process.exit(1)
  })
}
