import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {publishFormula} from "./publish.mjs"

const root = mkdtempSync(join(tmpdir(), "homebrew-publisher-test-"))
const checkout = join(root, "source")
const fake = join(root, "harn")
const result = join(root, "observed.json")
const commit = "b".repeat(40)
const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {cwd: checkout, encoding: "utf8"}).trim()
try {
  mkdirSync(checkout)
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Formula fixture")
  git("config", "user.email", "formula@example.test")
  mkdirSync(join(checkout, "Formula"))
  writeFileSync(join(checkout, "Formula/harn.rb"), "base\n")
  writeFileSync(join(checkout, "other.txt"), "base\n")
  git("add", "-A")
  git("commit", "-qm", "base")
  const expectedHead = git("rev-parse", "HEAD")
  writeFileSync(join(checkout, "other.txt"), "unrelated staged\n")
  git("add", "other.txt")
  writeFileSync(join(checkout, "Formula/harn.rb"), "unrelated unstaged\n")
  const before = git("status", "--porcelain=v1") + git("ls-files", "-s")
  // The process boundary control observes the real isolated Git index. HTTP and
  // signature behavior are proved separately through publish_test.harn's real adapter.
  writeFileSync(fake, `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const request=JSON.parse(readFileSync(process.argv.at(-1),'utf8'));
const git=(...args)=>execFileSync('git',args,{cwd:request.repo_dir,encoding:'utf8'}).trim();
writeFileSync(${JSON.stringify(result)},JSON.stringify({request,selected:git('show',':Formula/harn.rb'),status:git('status','--porcelain=v1')}));
if(process.env.FORMULA_TEST_REFUSE==='1')process.exit(7);
console.log(JSON.stringify({committed:true,commit_oid:${JSON.stringify(commit)},repository:request.owner+'/'+request.repo,branch:request.branch,source:'index',base_oid:request.base_oid,signature:{verified:true,signed_by_github:true},changes:[{path:'Formula/harn.rb',blob_oid:git('rev-parse',':Formula/harn.rb')}]}));
`)
  chmodSync(fake, 0o700)
  const request = {repository: "octo-org/octo-repo", branch: "automation/harn-formula-v0.10.171", expectedHead, formula: "selected formula\n", headline: "Update formula"}
  assert.equal(await publishFormula(request, {repositoryRoot: checkout, harn: fake}), commit)
  const observed = JSON.parse(readFileSync(result, "utf8"))
  assert.equal(observed.selected, "selected formula")
  assert.equal(observed.status, "M  Formula/harn.rb")
  assert.equal(observed.request.base_oid, expectedHead)
  assert.equal(git("status", "--porcelain=v1") + git("ls-files", "-s"), before)
  assert.equal(readFileSync(join(checkout, "Formula/harn.rb"), "utf8"), "unrelated unstaged\n")
  assert.throws(() => readFileSync(observed.request.repo_dir + "/Formula/harn.rb"), {code: "ENOENT"})
  process.env.FORMULA_TEST_REFUSE = "1"
  await assert.rejects(publishFormula(request, {repositoryRoot: checkout, harn: fake}), /failed \(7\)/)
  delete process.env.FORMULA_TEST_REFUSE
  assert.equal(git("status", "--porcelain=v1") + git("ls-files", "-s"), before)
  await assert.rejects(publishFormula({...request, expectedHead: "bad"}, {repositoryRoot: checkout, harn: fake}), /invalid signed/)
  // Reach the actual production child process and released adapter. A dummy
  // credential must stop at the read-only GitHub branch lookup, before mutation.
  git("reset", "--hard", expectedHead)
  const priorToken = process.env.GH_TOKEN
  try {
    process.env.GH_TOKEN = "fixture-not-a-live-token"
    await assert.rejects(publishFormula({...request, expectedHead: git("rev-parse", "HEAD")}, {
      repositoryRoot: checkout, harn: process.env.FORMULA_TEST_HARN ?? "harn",
    }), /failed \[auth\].*status 401/)
  } finally {
    if (priorToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = priorToken
  }
  assert.deepEqual(readdirSync(root).sort(), ["harn", "observed.json", "source"])
  console.log("signed formula process boundary: positive, refusal, invalid lease, caller preservation and real Harn unauthorized lookup refusal passed")
} finally {
  delete process.env.FORMULA_TEST_REFUSE
  rmSync(root, {recursive: true, force: true})
}
