#!/usr/bin/env node
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"

import {
  harnReleaseManifest,
  renderHarnFormula,
  validateHarnReleaseManifest,
} from "./update-harn-from-release.mjs"

const FORMULA_PATH = "Formula/harn.rb"
const BRANCH_ROOT = "automation/bump-harn-formula"
const SHA256 = /^[0-9a-f]{64}$/

export function branchForRelease(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`release tag must look like vX.Y.Z, got ${tag}`)
  }
  return `${BRANCH_ROOT}/${tag}`
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function checkSummary(contexts) {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    throw new Error("missing PR check observations")
  }
  const failingNames = []
  let pendingCount = 0
  for (const context of contexts) {
    const name = String(context?.name ?? "").trim()
    if (!name) {
      throw new Error("PR check observation is missing its name")
    }
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
    } else {
      throw new Error(`PR check ${name} has unknown kind`)
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
}

function receiptFor({ manifest, formulaSha256, workflowRunId, branch, headSha, pull, checks }) {
  return {
    schema_version: 1,
    state: pull?.merged ? "merged" : "pull_request_open",
    release_tag: manifest.release_tag,
    assets: manifest.assets.map(({ name, sha256: digest }) => ({name, sha256: digest})),
    formula_sha256: formulaSha256,
    workflow_run_id: workflowRunId,
    branch,
    head_sha: headSha,
    pull_request_number: pull.number,
    pull_request_url: pull.url,
    checks,
    merge_commit_sha: pull.merge_commit_sha ?? null,
    post_merge_formula_sha256: pull.post_merge_formula_sha256 ?? null,
  }
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
      assertExactSignedHead(observation, branch, publishedHead, formulaSha256)
      if (mergedPull.post_merge_formula_sha256 !== formulaSha256) {
        throw new Error(`merged pull request #${mergedPull.number} formula digest mismatch`)
      }
      return receiptFor({
        manifest,
        formulaSha256,
        workflowRunId,
        branch,
        headSha: publishedHead,
        pull: mergedPull,
        checks: checkSummary(mergedPull.check_contexts),
      })
    }
    return {
      schema_version: 1,
      state: "already_published",
      release_tag: manifest.release_tag,
      assets: manifest.assets.map(({ name, sha256: digest }) => ({name, sha256: digest})),
      formula_sha256: formulaSha256,
      workflow_run_id: workflowRunId,
      branch,
      head_sha: baseHead,
      pull_request_number: null,
      pull_request_url: null,
      checks: {
        observation_state: "not_applicable",
        total_count: 0,
        pending_count: 0,
        failing_count: 0,
        failing_names: [],
      },
      merge_commit_sha: baseHead,
      post_merge_formula_sha256: formulaSha256,
    }
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
  assertExactSignedHead(observation, branch, headSha, formulaSha256)

  let pull = exactPullRequest(observation, headSha)
  if (!pull) {
    await adapter.createPullRequest({
      repository,
      repositoryId: observation.repository_id,
      baseBranch,
      branch,
      title: `chore: update Harn formula to ${manifest.version}`,
      body: [
        `Regenerated \`${FORMULA_PATH}\` from the published \`${manifest.release_tag}\` release.`,
        "",
        "The producer downloaded and SHA-256 verified all four supported macOS/Linux archives before publishing this GitHub-signed exact-head commit.",
        "",
        "Opened by `.github/workflows/bump-harn-formula.yml`; this pull request remains unarmed for Fleet or a person to evaluate.",
      ].join("\n"),
    })
  }

  for (let attempt = 1; attempt <= checkAttempts; attempt += 1) {
    observation = await adapter.observe({repository, baseBranch, branch})
    assertExactSignedHead(observation, branch, headSha, formulaSha256)
    pull = exactPullRequest(observation, headSha)
    if (!pull) {
      if (attempt === checkAttempts) {
        throw new Error(`missing pull request observation for ${branch}@${headSha}`)
      }
    } else if (pull.is_draft) {
      throw new Error(`pull request #${pull.number} is draft; expected READY`)
    } else if (pull.check_contexts?.length > 0) {
      const checks = checkSummary(pull.check_contexts)
      if (pull.merged && !pull.post_merge_formula_sha256) {
        throw new Error(`merged pull request #${pull.number} is missing post-merge formula observation`)
      }
      return receiptFor({manifest, formulaSha256, workflowRunId, branch, headSha, pull, checks})
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
        number url state isDraft merged headRefOid
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
          number: pull.number,
          url: pull.url,
          state: pull.state,
          is_draft: pull.isDraft,
          merged: pull.merged,
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
