import { appendFileSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export function smokePlatforms(value) {
  if (!Array.isArray(value) || value.length === 0
      || value.some(os => typeof os !== "string" || !/^(ubuntu|macos)-[0-9.]+$/.test(os))
      || new Set(value).size !== value.length) {
    throw new Error("Formula smoke platforms must be a nonempty, unique runner list")
  }
  return value
}

export function formulaSmokeProof(platforms, jobs, requireBurin) {
  smokePlatforms(platforms)
  if (!Array.isArray(jobs) || typeof requireBurin !== "boolean") {
    throw new Error("Formula smoke evidence is unreadable; no proof was measured")
  }
  const pending = []
  const failed = []
  for (const os of platforms) {
    const observed = jobs.filter(job => job.name === `Harn formula install smoke (${os})`)
    if (observed.some(job => !Number.isInteger(job.run_attempt) || job.run_attempt < 1
        || !["queued", "in_progress", "waiting", "requested", "pending", "completed"].includes(job.status))) {
      throw new Error(`Formula smoke attempt identity is unmeasured for ${os}`)
    }
    const attempt = Math.max(0, ...observed.map(job => job.run_attempt))
    const rows = observed.filter(job => job.run_attempt === attempt)
    if (rows.length === 0 || (rows.length === 1 && rows[0].status !== "completed")) {
      pending.push(os)
      continue
    }
    const job = rows[0]
    const required = ["Harn formula install smoke"]
    if (requireBurin) required.push("Burin formula install smoke")
    if (rows.length !== 1 || job.conclusion !== "success"
        || !Array.isArray(job.steps)
        || required.some(name => job.steps.filter(step => step.name === name
          && step.status === "completed" && step.conclusion === "success").length !== 1)) {
      failed.push(os)
    }
  }
  return {
    ok: pending.length === 0 && failed.length === 0,
    total_count: platforms.length,
    proven_count: platforms.length - pending.length - failed.length,
    pending_count: pending.length,
    pending_platforms: pending,
    failing_count: failed.length,
    failing_platforms: failed,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const platforms = smokePlatforms(JSON.parse(readFileSync(
      new URL("../formula-smoke-platforms.json", import.meta.url), "utf8",
    )))
    if (process.argv[2] === "--prove" && ["true", "false"].includes(process.argv[4])) {
      const proof = formulaSmokeProof(platforms,
        JSON.parse(readFileSync(process.argv[3], "utf8")), process.argv[4] === "true")
      const rendered = JSON.stringify(proof)
      console.log(rendered)
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Formula install proof: ${rendered}\n`)
      process.exitCode = proof.ok ? 0 : 1
    } else {
      throw new Error("Use --prove JOBS_JSON REQUIRE_BURIN_BOOLEAN")
    }
  } catch (error) {
    console.error(`Formula install proof unmeasured: ${error.message}`)
    process.exitCode = 1
  }
}
