# Homebrew tap for Burin

> **Pre-release software, not yet supported.** Everything in this tap is under
> active development ahead of a public launch. Expect breaking changes between
> releases, including to command line interfaces and on-disk formats. There is
> no compatibility guarantee between any two versions and no support channel.
> If you found this tap before launch, install it expecting to be surprised.

Releases move quickly — often more than one a day. `brew upgrade` often; an
install left alone for a few days is likely to be several releases behind, and
running a stale build means running bugs that are already fixed upstream.

This tap is prepared for the public launch, but the stable install channel is
still gated until Burin Code distribution is explicitly enabled.

Once launch is enabled:

```sh
brew tap burin-labs/burin
brew install harn
brew install burin
brew install --cask burin-code
```

`harn` installs the Harn runtime and CLI, including `harn serve acp` for
third-party ACP hosts. `burin` installs the cross-platform terminal UI.
`burin-code` installs the macOS IDE from the signed DMG release artifact.

The `burin` formula and `burin-code` cask are generated from the
`release.json` asset published by `burin-labs/burin-code` releases:

```sh
node script/update-from-release.mjs --release-manifest /path/to/release.json
```

The `harn` formula is generated from a Harn GitHub release JSON object:

```sh
gh release view --repo burin-labs/harn --json tagName,assets \
  > /tmp/harn-release.json
node script/update-harn-from-release.mjs --release-json /tmp/harn-release.json
```

You should not normally need to run that by hand. Harn Fleet dispatches
`.github/workflows/bump-harn-formula.yml` with an exact release tag; the daily
schedule is a recovery alarm if that release dispatch is missed. The producer
downloads and SHA-256 verifies exactly the four supported macOS/Linux archives,
publishes a GitHub-signed commit to
`automation/harn-formula-vX.Y.Z` under an exact-head lease, and opens an
unarmed pull request for tap CI. Each successful run uploads a typed lifecycle
receipt that records the release, assets, formula hash, exact branch and head,
pull request, observed checks, and eventual merge fields.

CI always runs `brew style`, `brew audit`, and the generator fixture tests.
Install smoke runs when the referenced release assets are publicly reachable.
