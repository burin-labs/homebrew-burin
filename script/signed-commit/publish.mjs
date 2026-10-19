import {spawn} from "node:child_process"
import {lstat, mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = join(moduleDirectory, "../..")
const sha = /^[0-9a-f]{40}$/

function run(program, args, {cwd, env = process.env} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {cwd, env, stdio: ["ignore", "pipe", "pipe"]})
    let stdout = "", stderr = ""
    child.stdout.on("data", (data) => { stdout += data })
    child.stderr.on("data", (data) => { stderr += data })
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${program} failed (${code}): ${stderr}`)))
  })
}

/** Stage only the formula in a disposable index; the released adapter owns publication. */
export async function publishFormula(request, {repositoryRoot = repositoryDirectory, harn = "harn"} = {}) {
  const {repository, branch, expectedHead, formula, headline} = request
  const parts = repository.split("/")
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part)) ||
      !sha.test(expectedHead) || !/^automation\/harn-formula-v\d+\.\d+\.\d+$/.test(branch) ||
      typeof formula !== "string" || typeof headline !== "string" || !headline.trim()) {
    throw new Error("invalid signed formula publication request")
  }
  const temporary = await mkdtemp(join(tmpdir(), "homebrew-signed-formula-"))
  const checkout = join(temporary, "checkout")
  // Git reads public objects only. Publishing credentials reach Harn through its environment.
  const gitEnvironment = {...process.env, GIT_TERMINAL_PROMPT: "0"}
  delete gitEnvironment.GH_TOKEN
  delete gitEnvironment.GITHUB_TOKEN
  const git = (args) => run("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
    cwd: checkout, env: gitEnvironment,
  })
  try {
    await run("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "clone", "--shared", "--no-checkout", repositoryRoot, checkout], {
      env: gitEnvironment,
    })
    try { await git(["cat-file", "-e", `${expectedHead}^{commit}`]) }
    catch { await git(["fetch", "--no-tags", `https://github.com/${repository}.git`, expectedHead]) }
    await git(["checkout", "--detach", expectedHead])
    const formulaPath = join(checkout, "Formula/harn.rb")
    if (!(await lstat(join(checkout, "Formula"))).isDirectory()) throw new Error("formula directory must be a real directory")
    if (!(await lstat(formulaPath)).isFile()) throw new Error("selected formula must be a regular file")
    await writeFile(formulaPath, formula)
    await git(["add", "--", "Formula/harn.rb"])
    const selectedBlob = (await git(["rev-parse", ":Formula/harn.rb"])).trim()
    const metadata = join(temporary, "request.json")
    await writeFile(metadata, JSON.stringify({
      owner: parts[0], repo: parts[1], branch, headline, repo_dir: checkout, base_oid: expectedHead,
    }), {mode: 0o600})
    const output = await run(harn, ["run", "--no-sandbox", join(moduleDirectory, "publish.harn"), "--", metadata], {cwd: moduleDirectory})
    const receipt = JSON.parse(output)
    if (!receipt.committed || !sha.test(receipt.commit_oid) || receipt.repository !== repository ||
        receipt.branch !== branch || receipt.source !== "index" || receipt.base_oid !== expectedHead ||
        receipt.signature?.verified !== true || receipt.signature?.signed_by_github !== true ||
        receipt.changes?.length !== 1 || receipt.changes[0].path !== "Formula/harn.rb" ||
        receipt.changes[0].blob_oid !== selectedBlob || await readFile(formulaPath, "utf8") !== formula) {
      throw new Error("signed formula receipt did not identify the selected formula and lease")
    }
    return receipt.commit_oid
  } finally {
    await rm(temporary, {recursive: true, force: true})
  }
}
