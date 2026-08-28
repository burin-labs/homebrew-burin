#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const EXIT = {
  ok: 0,
  usage: 1,
  noUrl: 2,
  unreachable: 3,
}

/// First stable `url "..."` in a formula. `head "..."` is not a public install
/// path and must not count. Matches the previous CI ruby one-liner.
export function extractStableUrl(formulaSource) {
  const match = formulaSource.match(/^\s*url "([^"]+)"/m)
  return match?.[1] ?? ""
}

export function classifyStableUrl(url, reachable) {
  if (!url) {
    return {
      status: "no-url",
      exitCode: EXIT.noUrl,
      message:
        "Formula has no stable url (head-only). Install smoke cannot pass without an install.",
    }
  }
  if (!reachable) {
    return {
      status: "unreachable",
      exitCode: EXIT.unreachable,
      url,
      message: `Stable formula URL is not publicly reachable: ${url}`,
    }
  }
  return { status: "ok", exitCode: EXIT.ok, url }
}

export function probeUrl(url, { curlBin = process.env.CURL_BIN || "curl" } = {}) {
  const result = spawnSync(curlBin, ["-fsIL", url], {
    stdio: ["ignore", "ignore", "pipe"],
  })
  return result.status === 0
}

export function classifyFormulaSource(formulaSource, options = {}) {
  const url = extractStableUrl(formulaSource)
  if (!url) {
    return classifyStableUrl("", false)
  }
  const reachable =
    typeof options.reachable === "boolean"
      ? options.reachable
      : probeUrl(url, options)
  return classifyStableUrl(url, reachable)
}

function main(argv = process.argv) {
  const formulaPath = argv[2]
  if (!formulaPath) {
    process.stderr.write("usage: formula-url-preflight.mjs <formula.rb>\n")
    process.exit(EXIT.usage)
  }
  const result = classifyFormulaSource(readFileSync(formulaPath, "utf8"))
  if (result.exitCode !== EXIT.ok) {
    process.stderr.write(`${result.message}\n`)
    process.exit(result.exitCode)
  }
  process.stdout.write(`${result.url}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
