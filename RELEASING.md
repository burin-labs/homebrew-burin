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

Three things must be true, and none of them are in this repository. Check them
first, because the generator will happily produce a formula that installs
cleanly and then fails for the user.

1. **The release is published, not a draft.** Draft release assets return 404
   to anonymous clients, so a formula pointing at one fails for every user
   while working for anyone signed in with repo access.
2. **The release carries the standalone CLI archives.** The generator requires
   `cli-darwin-arm64`, `cli-darwin-x64`, `cli-linux-x64`, and `cli-linux-arm64`
   in `release.json`, and refuses to render without all four. They first appear
   in releases built after burin-code#6405; `v0.2.0` predates it.
3. **`burin-code` release assets are publicly readable.** This is what the
   whole flip is waiting on.

## What changes on its own

CI's install smoke step currently skips itself, because it probes the formula
URL and finds nothing publicly reachable. Once the assets are public, that step
starts running `brew install` and `brew test` for real. Expect the first public
CI run to take noticeably longer, and to be the first end-to-end proof that the
published artifacts install.

## What the formula installs, and why it is shaped this way

The formula installs the **standalone per-platform archive**, which carries the
`burin` binary at the archive root.

It does not install the npm shim, which is what it used to do. The shim carries
no binary: it resolves one from a per-platform `optionalDependency`, and its
postinstall soft-fails when that package is missing. Installing it therefore
succeeded with exit 0 and failed at first run with `burin runtime binary not
found`. The shim tarball is still downloaded, as a `resource`, but only for the
pipelines and provider catalog it carries.

Those land in `share/burin/`, which is where the binary's release-install
resolver looks for them. Without them `burin --version` still answers and every
agent turn fails, so the formula's own `test` block runs
`burin headless diagnose` rather than stopping at the version check.

The wrapper script in `bin/burin` is a **workaround**, not a design choice. It
sets `BURIN_PIPELINE_DIR` only when unset, because `burin` has two pipeline
resolvers and only one of them knows about install layouts. Delete it once
burin-code#6410 is fixed; the layout it points at is already what the other
resolver looks for.

## Verifying before a real release exists

The generator's URL allowlist only accepts `burin-code` release assets, so a
local rehearsal renders through `renderFormula` directly with `file://` URLs
and a locally built archive in the same layout: a `.tar.gz` with the `burin`
binary at its root, plus the npm tarball for the bundle resource. Install it
from a scratch tap with `brew install --build-from-source`, then run
`burin headless diagnose` from a directory outside any checkout, with a clean
environment. A passing `--version` is not evidence on its own.
