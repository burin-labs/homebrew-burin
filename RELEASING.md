# Releasing the tap

On the day `burin-code` goes public, the tap needs **one commit**: regenerate
the formula and cask from the newest release manifest, and merge.

```sh
gh release download <tag> --repo burin-labs/burin-code --pattern release.json
node script/update-from-release.mjs --release-manifest release.json
```

Commit the changed `Formula/burin.rb`, `Casks/burin-code.rb`, and `README.md`.
Nothing else in this repository changes.

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
5. **`Formula/harn.rb` is at or above the Harn version `burin` was built
   against.** `burin` delegates its agent subcommands to `harn`, and the
   formula now depends on it. A `harn` older than the bundle's own pin
   recompiles every pipeline from source instead of loading the precompiled
   bytecode that ships with it, and an old enough one cannot compile them at
   all. Regenerate `harn.rb` from the matching Harn release in the same
   commit. As of this writing `harn.rb` pins 0.9.17 while `burin-code` pins
   0.10.102, so this is a real gap, not a formality.
6. **`burin-code` release assets are publicly readable.** This is what the
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
- a Regen drift check that could not read `burin-code` releases at all.

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

The formula installs the **standalone per-platform archive**, which carries the
`burin` binary at the archive root.

It does not install the npm shim, which is what it used to do. The shim carries
no binary: it resolves one from a per-platform `optionalDependency`, and its
postinstall soft-fails when that package is missing. Installing it therefore
succeeded with exit 0 and failed at first run with `burin runtime binary not
found`. The shim tarball is still downloaded, as a `resource`, but only for the
pipelines and provider catalog it carries.

Those land in `share/burin/`, which is where the binary looks for them: it
probes `<exe_dir>/../share/burin/pipelines`, so `bin` plus `share` is already
the layout it expects. Alongside them go `harn.toml`, `harn.lock`, and
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

The generator's URL allowlist only accepts `burin-code` release assets, so a
local rehearsal renders through `renderFormula` directly with `file://` URLs
and locally built stand-ins in the same layout: a `.tar.gz` with the `burin`
binary at its root, plus `npm pack` output from a `burin-code` checkout for
the bundle resource. Install it from a scratch tap with
`brew install --build-from-source`, then run `burin headless diagnose` from a
directory outside any checkout, with a clean `HOME` and a `PATH` carrying only
`harn` and the system directories.

Read the result, not the exit path: a passing `--version` is not evidence, and
neither is the absence of a particular error. `exit_code: 0` in the diagnose
report is. Finish by removing the scratch tap and the installed formula.
