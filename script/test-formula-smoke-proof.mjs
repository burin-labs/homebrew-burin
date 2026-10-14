import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { smokePlatforms, formulaSmokeProof } from "./formula-smoke-proof.mjs"

const platforms = smokePlatforms(JSON.parse(readFileSync(
  new URL("../formula-smoke-platforms.json", import.meta.url), "utf8")))
const passed = name => ({ name, status: "completed", conclusion: "success" })
const jobs = platforms.map(os => ({ ...passed(`Harn formula install smoke (${os})`), run_attempt: 1,
  steps: [passed("Harn formula install smoke"), passed("Burin formula install smoke")] }))
assert.equal(formulaSmokeProof(platforms, jobs, true).ok, true)
assert.throws(() => smokePlatforms([]), /nonempty/)
assert.throws(() => smokePlatforms([platforms[0], platforms[0]]), /unique/)
assert.throws(() => formulaSmokeProof(platforms, {}, false), /unreadable/)
const absent = formulaSmokeProof(platforms, [], false)
assert.equal(absent.ok, false)
assert.equal(absent.pending_count, platforms.length)
assert.deepEqual(absent.pending_platforms, platforms)
for (const conclusion of ["skipped", "failure", "cancelled", "neutral", null]) {
  const result = formulaSmokeProof(platforms,
    jobs.map(job => ({ ...job, steps: [{ ...passed("Harn formula install smoke"), conclusion }] })), false)
  assert.equal(result.ok, false)
  assert.deepEqual(result.failing_platforms, platforms)
}
assert.equal(formulaSmokeProof(platforms, jobs.map(job => ({ ...job, steps: [] })), false).ok, false)
const harnOnly = jobs.map(job => ({ ...job, steps: [passed("Harn formula install smoke")] }))
assert.equal(formulaSmokeProof(platforms, harnOnly, false).ok, true)
assert.equal(formulaSmokeProof(platforms, harnOnly, true).ok, false)
assert.equal(formulaSmokeProof(platforms, [...jobs, jobs[0]], false).ok, false)
const rerun = { ...jobs[0], run_attempt: 2, status: "queued", conclusion: null }
const queued = formulaSmokeProof(platforms, [...jobs, rerun], false)
assert.equal(queued.pending_count, 1)
assert.deepEqual(queued.pending_platforms, [platforms[0]])
assert.equal(formulaSmokeProof(platforms, [...jobs, { ...rerun, ...passed(rerun.name) }], false).ok, true)

const parsed = spawnSync("ruby", ["-ryaml", "-rjson", "-e",
  "puts JSON.generate(YAML.load_file(ARGV[0]))",
  new URL("../.github/workflows/ci.yml", import.meta.url).pathname], { encoding: "utf8" })
assert.equal(parsed.status, 0, parsed.stderr)
const workflow = JSON.parse(parsed.stdout)
const smoke = workflow.jobs["tap-checks"]
assert.equal(smoke.name, "Harn formula install smoke (${{ matrix.os }})")
assert.equal(smoke.if, "always()")
assert.deepEqual(smoke.strategy.matrix.os, platforms)
assert.equal(workflow.jobs["formula-install-smoke"], undefined)
assert.deepEqual(Object.entries(workflow.jobs).filter(([, job]) =>
  /formula install smoke/i.test(job.name ?? "")).map(([id]) => id), ["tap-checks"])
assert.ok(workflow.jobs["formula-url-preflight"].steps.some(step =>
  step.run === "node script/test-formula-smoke-proof.mjs"), "contract runs outside the matrix")

const root = mkdtempSync(join(tmpdir(), "formula-smoke-proof-"))
try {
  const commands = join(root, "commands")
  writeFileSync(join(root, "brew"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SMOKE_COMMANDS"\n`, { mode: 0o755 })
  for (const formula of ["harn", "burin"]) {
    const step = smoke.steps.find(step => step.name === `${formula === "harn" ? "Harn" : "Burin"} formula install smoke`)
    assert.ok(step)
    if (formula === "harn") assert.equal(step.if, undefined)
    else assert.equal(step.if, "needs.formula-url-preflight.outputs.should_install == 'true'")
    writeFileSync(commands, "")
    const stepScript = join(root, `${formula}.sh`)
    writeFileSync(stepScript, step.run)
    const result = spawnSync("bash", ["-e", stepScript], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SMOKE_COMMANDS: commands }, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(commands, "utf8").trim().split("\n"),
      [`install burin-labs/burin/${formula}`, `test burin-labs/burin/${formula}`])
  }
  writeFileSync(join(root, "brew"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SMOKE_COMMANDS"\nexit 7\n`, { mode: 0o755 })
  writeFileSync(commands, "")
  const refused = spawnSync("bash", ["-e", join(root, "harn.sh")], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SMOKE_COMMANDS: commands }, encoding: "utf8" })
  assert.equal(refused.status, 7)
  assert.deepEqual(readFileSync(commands, "utf8").trim().split("\n"), ["install burin-labs/burin/harn"])
  const evidence = join(root, "jobs.json")
  const script = new URL("./formula-smoke-proof.mjs", import.meta.url).pathname
  for (const rows of [jobs, [], harnOnly]) {
    writeFileSync(evidence, JSON.stringify(rows))
    const result = spawnSync(process.execPath, [script, "--prove", evidence, "true"], { encoding: "utf8" })
    assert.equal(result.status, rows === jobs ? 0 : 1, result.stderr)
    assert.equal(JSON.parse(result.stdout).ok, rows === jobs)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("test-formula-smoke-proof: OK")
