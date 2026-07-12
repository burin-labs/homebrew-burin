# Homebrew tap for Burin

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

CI always runs `brew style`, `brew audit`, and the generator fixture tests.
Install smoke runs when the referenced release assets are publicly reachable.
