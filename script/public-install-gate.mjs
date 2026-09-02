#!/usr/bin/env node
//
// Decides whether the committed tap agrees with `public-install.json` about
// whether the public can install `burin` today.
//
// WHY THIS GATE EXISTS
// `brew install burin` has been impossible for every public user since the tap
// was created (homebrew-burin#15), and tap CI has been green the whole time.
// It was green honestly: `brew style` and `brew audit --strict` both pass on a
// head-only formula, because neither asks whether anyone can install it, and
// the install smoke job correctly declines to claim success it did not earn.
// But "declined to run" and "ran and passed" both arrived at `ci-status` as a
// green, so the one fact that mattered was the one nothing asserted.
//
// The fix is not another probe. The probe already exists and is already right:
// `formula-url-preflight.mjs` classifies the committed formula as `ok`,
// `no-url` (head-only), or `unreachable`. What was missing is a declaration to
// compare it against, so that a skip has to be a *chosen* skip.
//
// So `public-install.json` states, as a typed fact with an owner, whether
// public install is supposed to work. This gate fails when reality and the
// declaration disagree -- IN EITHER DIRECTION:
//
//   * declared off + formula uninstallable -> gated. Green, loudly labelled.
//   * declared off + formula installable   -> FAIL. The launch flip happened
//     in the formula and nobody flipped the declaration, so install smoke is
//     still allowed to skip. This is the direction a totality gate misses.
//   * declared on  + formula installable   -> live, and install smoke becomes
//     MANDATORY: a skipped install is no longer an acceptable `ci-status`.
//   * declared on  + formula uninstallable -> FAIL. This is issue #15 itself,
//     and after the flip it can never be green again.
//
// The gate is deliberately not satisfied by the formula alone. A formula can be
// syntactically perfect, audit clean, and still unreachable; that is exactly the
// state this tap has been in for weeks.

import { appendFileSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const EXIT = {
  ok: 0,
  usage: 1,
  declarationStale: 2,
  declarationBroken: 3,
  malformed: 4,
}

/// Statuses `formula-url-preflight.mjs` can report. Kept as a set so a typo in
/// the workflow wiring fails here instead of being read as "not ok".
export const PREFLIGHT_STATUSES = new Set(["ok", "no-url", "unreachable"])

/**
 * Parse `public-install.json`.
 *
 * Strict on purpose: a missing or non-boolean `publicInstallEnabled` is a
 * malformed declaration, never a default. A defaulted `false` here would
 * silently re-create the silent green this gate exists to remove.
 */
export function parseDeclaration(source) {
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`public-install.json is not valid JSON: ${error.message}`)
  }
  if (typeof parsed.publicInstallEnabled !== "boolean") {
    throw new Error(
      "public-install.json must set `publicInstallEnabled` to a boolean. "
        + "There is no default: an absent value would mean this gate does not know "
        + "whether public install works, and not knowing is not a pass.",
    )
  }
  if (!parsed.publicInstallEnabled) {
    const reason = parsed.reason
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        "public-install.json disables public install but gives no `reason`. "
          + "A gate held shut without a stated reason is how #15 stayed open for weeks.",
      )
    }
  }
  return {
    publicInstallEnabled: parsed.publicInstallEnabled,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    blockedBy: typeof parsed.blockedBy === "string" ? parsed.blockedBy : "",
  }
}

/**
 * Compare the declaration against what the preflight actually found.
 *
 * `requireInstallSmoke` is the value `ci-status` must consume: when it is true,
 * a skipped install smoke is a failure rather than an accepted outcome.
 */
export function decide({ declaration, preflightStatus }) {
  if (!PREFLIGHT_STATUSES.has(preflightStatus)) {
    return {
      verdict: "malformed",
      exitCode: EXIT.malformed,
      requireInstallSmoke: true,
      message:
        `Unknown preflight status ${JSON.stringify(preflightStatus)}. `
        + `Expected one of: ${[...PREFLIGHT_STATUSES].join(", ")}. `
        + "Refusing to guess, because every guess here reads as a pass.",
    }
  }
  const installable = preflightStatus === "ok"
  if (declaration.publicInstallEnabled && installable) {
    return {
      verdict: "live",
      exitCode: EXIT.ok,
      requireInstallSmoke: true,
      message:
        "Public install is enabled and the committed formula has a reachable stable URL. "
        + "Install smoke is mandatory: a skipped install is now a CI failure.",
    }
  }
  if (declaration.publicInstallEnabled && !installable) {
    return {
      verdict: "declaration-broken",
      exitCode: EXIT.declarationBroken,
      requireInstallSmoke: true,
      message:
        "public-install.json says the public can install `burin`, but the committed formula "
        + `is ${preflightStatus === "no-url" ? "head-only" : "pointing at an unreachable URL"}. `
        + "This is homebrew-burin#15. Regenerate the formula from a published release "
        + "(node script/update-from-release.mjs --release-manifest release.json) or flip "
        + "publicInstallEnabled back to false with a reason.",
    }
  }
  if (!declaration.publicInstallEnabled && installable) {
    return {
      verdict: "declaration-stale",
      exitCode: EXIT.declarationStale,
      requireInstallSmoke: false,
      message:
        "The committed formula now has a reachable stable URL, but public-install.json still "
        + "says public install is disabled. While it says that, install smoke is allowed to "
        + "skip, so the formula that finally works is the one nothing installs. "
        + "Set publicInstallEnabled to true.",
    }
  }
  return {
    verdict: "gated",
    exitCode: EXIT.ok,
    requireInstallSmoke: false,
    message:
      `Public install is DISABLED by declaration, and the committed formula agrees `
      + `(${preflightStatus}). \`brew install burin\` does not work for the public. `
      + `Reason: ${declaration.reason}`,
  }
}

export function githubOutputs(result) {
  return {
    verdict: result.verdict,
    require_install_smoke: result.requireInstallSmoke ? "true" : "false",
    message: result.message,
  }
}

export function formatGithubOutput(result) {
  return (
    Object.entries(githubOutputs(result))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  )
}

export function writeGithubOutput(result, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    return
  }
  appendFileSync(outputPath, formatGithubOutput(result))
}

/// `gated` is the only non-failing state that a reader could mistake for
/// "everything is fine", so it is the one that gets an annotation.
export function githubAnnotation(result) {
  if (result.verdict === "gated") {
    return `::warning::${result.message}`
  }
  if (result.exitCode !== EXIT.ok) {
    return `::error::${result.message}`
  }
  return ""
}

function main(argv = process.argv) {
  const declarationPath = argv[2]
  const preflightStatus = argv[3]
  if (!declarationPath || !preflightStatus) {
    process.stderr.write(
      "usage: public-install-gate.mjs <public-install.json> <preflight-status>\n",
    )
    process.exit(EXIT.usage)
  }
  let declaration
  try {
    declaration = parseDeclaration(readFileSync(declarationPath, "utf8"))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(EXIT.malformed)
  }
  const result = decide({ declaration, preflightStatus })
  writeGithubOutput(result)
  const annotation = githubAnnotation(result)
  if (annotation && process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`${annotation}\n`)
  }
  if (result.exitCode !== EXIT.ok) {
    process.stderr.write(`${result.message}\n`)
    process.exit(result.exitCode)
  }
  process.stdout.write(`${result.verdict}: ${result.message}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
