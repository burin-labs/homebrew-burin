# Homebrew tap for Burin

This tap is prepared for the public launch, but the stable install channel is
still gated until Burin Code distribution is explicitly enabled.

Once launch is enabled:

```sh
brew tap burin-labs/burin
brew install burin
brew install --cask burin-code
```

`burin` installs the cross-platform terminal UI. `burin-code` installs the
macOS IDE from the signed DMG release artifact.

The formula and cask are generated from the `release.json` asset published by
`burin-labs/burin-code` releases:

```sh
node script/update-from-release.mjs --release-manifest /path/to/release.json
```

CI always runs `brew style`, `brew audit`, and the generator fixture test.
Install smoke runs when the referenced release assets are publicly reachable.
