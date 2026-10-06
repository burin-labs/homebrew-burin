# Releasing the tap

When the public release is published, the tap needs **one commit**: regenerate
the formula and cask from the newest release manifest, and merge.

```sh
gh release download <tag> --repo burin-labs/burin-releases --pattern release.json
node script/update-from-release.mjs --release-manifest release.json
```

Commit the changed `Formula/burin.rb`, `Casks/burin-code.rb`, and `README.md`.
Flip `publicInstallEnabled` in the same commit after anonymous downloads pass.
The source repository remains private. The generator owns the public release
repository used by its artifact allowlist and CI's release discovery.

## Before that commit can work

Six things must be true, and only one of them is in this repository. Check them
first, because the generator will happily produce a formula that installs
cleanly and then fails for the user.

1. **The release is published, not a draft.** Draft release assets return 404
   to anonymous clients, so a formula pointing at one fails for every user
   while working for anyone signed in with repo access.
2. **The release carries the standalone CLI archives.** The generator requires
   `cli-darwin-arm64`, `cli-darwin-x64`, `cli-linux-x64`, and `cli-linux-arm64`
   in `release.json`, and refuses to render without all four. They first appear
   in releases built after burin-code#6405; `v0.2.0` predates it.
3. **The release was built after burin-code#6417.** That is the commit where
   `burin` learned to look for its pipelines beside its own executable. The
   formula no longer sets `BURIN_PIPELINE_DIR`, so a binary older than #6417
   installs, answers `--version`, and fails every agent turn. There is a window
   between #6405 and #6417 where a release carries the archives without the
   fix; those releases need the wrapper this formula no longer has, so do not
   point the formula at one.
4. **The release was built after burin-code#6422.** That is where the CLI
   bundle started carrying `harn.toml`, `harn.lock`, and `.harn`, the Harn
   package boundary that lets the bundled pipelines compile outside a
   checkout. The formula installs all three; without them in the tarball the
   `install` block fails outright, which is the loud version of the failure.
5. **Each standalone archive carries its exact Harn runtime and package.**
   The formula installs `burin`, `harn`, pipelines, provider catalog,
   `providers.toml`, `harn.toml`, `harn.lock`, `.harn`, `LICENSE`, and
   `THIRD-PARTY-NOTICES.txt` from that one archive. Missing inputs fail install.
   The separate `harn` formula does not supply Burin's runtime.
6. **`burin-releases` assets are publicly readable.** This is what the
   whole flip is waiting on.

## The switch: `public-install.json`

`public-install.json` states, as one typed fact, whether the public can install
`burin` today. It is the only thing the launch flip has to change in this
repository, and CI refuses to disagree with it in either direction.

```json
{ "publicInstallEnabled": false, "reason": "..." }
```

While it is `false`, Formula install smoke is allowed to skip and the Public
install gate reports `gated` with the reason attached to the run summary. The
moment it is `true`, three things become hard failures that were previously
green:

- a head-only or unreachable `Formula/burin.rb`,
- a Formula install smoke that skipped rather than installed,
- a Regen drift check that could not read the public release manifest.

The reverse direction fails too. If `Formula/burin.rb` gains a reachable stable
URL while `public-install.json` still says `false`, CI fails with
`declaration-stale`, because that combination silently keeps install smoke
switched off on exactly the formula that finally works.

Flip it in the same commit that regenerates the formula, never before and never
after.

Note that `script/update-from-release.mjs` also rewrites `README.md`, and the
generated README does not carry the hand-written pre-release warning that the
committed one does. Regenerating at launch will drop that warning. That is
probably correct at launch, but decide it deliberately rather than discovering
it in the diff.

## What changes on its own

CI classifies the formula URL in the Formula URL preflight job. Head-only and
an unreachable stable URL are distinct annotations; both GitHub-skip Formula
install smoke instead of reporting a successful install. The Public install
gate then decides whether that skip was legitimate, by comparing the
classification against `public-install.json`. Once the assets are public and
the declaration is flipped, install smoke starts running `brew install` and
`brew test` for real, and a skip stops being an acceptable aggregate result.
Expect the first public CI run to take noticeably longer, and to be the first
end-to-end proof that the published artifacts install.

## What the formula installs, and why it is shaped this way

The formula installs the complete **standalone per-platform archive** into
`libexec`, with only `burin` linked into `bin`. Burin resolves its real executable
directory and finds the pinned `harn` and resources beside it. An independently
installed `harn` command remains separate. Pipelines and the provider catalog
come from the same archive, along with `LICENSE` and `THIRD-PARTY-NOTICES.txt`.

Beside the pipelines go `harn.toml`, `harn.lock`, and
`.harn`: the manifest grants the bundled pipelines the privileged host
dispatch they are built on, and the other two resolve the packages that
manifest depends on. Harn finds all three by walking up from the pipeline it
compiles, so they sit beside `pipelines`, never inside it, and a user's own
project never inherits the grant.

The `test` block runs `burin headless diagnose` and reads its JSON result,
because each of the failures above is invisible one layer up. `--version`
answers with no pipelines at all; pipelines resolve fine and still fail to
compile without the manifest. Only a real subcommand's own report separates a
working install from a broken one.

There is no wrapper script and no environment variable. The formula used to
install one, setting `BURIN_PIPELINE_DIR`, because `burin` had three pipeline
resolvers and the two behind `headless` never looked beside the executable.
burin-code#6417 gave resolution one owner that does, so the wrapper became a
variable that masked a bug instead of fixing one. Preconditions 3 and 4 above
are the cost of removing it: the formula now depends on the binary and its
bundle being new enough.

One known limitation, measured: a **read-only install prefix** fails, because
Harn opens `.harn/package-install.lock` for write. A standard `brew` prefix is
user-writable, so this does not affect a normal install; a root-owned or
shared prefix would need burin-code to stage the package boundary into a
writable directory the way the macOS app already does.

## Verifying before a real release exists

The generator's URL allowlist only accepts `burin-releases` release assets, so a
local rehearsal renders through `renderFormula` directly with `file://` URLs
and locally built stand-ins in the same complete archive layout. Such a rehearsal
proves installation plumbing; final acceptance requires the qualified signed
release artifacts. Install it from a scratch tap with
`brew install --build-from-source`, then run `burin headless diagnose` from a
directory outside any checkout, with a clean `HOME` and a `PATH` carrying only
the system directories, so diagnosis must reach the packaged Harn runtime.

Read the result, not the exit path: a passing `--version` is not evidence, and
neither is the absence of a particular error. `exit_code: 0` in the diagnose
report is. Finish by removing the scratch tap and the installed formula.
