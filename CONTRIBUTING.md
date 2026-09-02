# Contributing

This repository does not accept external contributions.

`homebrew-burin` is the Homebrew tap that distributes the Burin Code app, the
`burin` CLI, and the Harn runtime. It is a publishing channel, not a project
with a roadmap. The formula and cask files in `Formula/` and `Casks/` are
generated from upstream releases by the scripts in `script/` and are pushed
here by the release bot. A hand-edited formula is overwritten by the next
release bump, usually within a day.

## Where to send a bug or a request

Report the problem where the software is built, not where it is packaged.

- Something wrong with the Burin Code app or the `burin` CLI:
  <https://github.com/burin-labs/burin-code/issues>
- Something wrong with the Harn runtime or the `harn` CLI:
  <https://github.com/burin-labs/harn/issues>

Open an issue here only when the tap itself is at fault: a formula that does
not install, a stale or wrong version pin, a checksum that does not match, or
a broken download URL. Include the output of `brew config` and the failing
`brew install` output.

Burin is pre-release software ahead of a public launch. Breaking changes
between releases are expected, including to command line interfaces and
on-disk formats, and there is no support channel yet. `README.md` says the
same thing at more length.

## If you have write access here

- Do not hand-edit `Formula/*.rb` or `Casks/*.rb`. Change the generator in
  `script/` instead, and let a release bump regenerate the file. `RELEASING.md`
  describes that flow.
- `.github/workflows/ci.yml` and `.github/dependabot.yml` are org-managed
  projections. Change them at their owning repository.
- Run the generator tests in `script/` before you push.

## Pull request titles

Use `[Area] Sentence case`, where the area is one of `Formula`, `CI`, or
`Docs`.

- `[Formula] Use pkgshare in the generated burin formula`
- `[CI] Stop reporting green on a head-only formula smoke`
- `[Docs] Say which install channel is gated before launch`

Keep the title on one line, under about 70 characters, and say what changed
rather than which files moved. Capitalize the first word after the bracket and
leave the rest in sentence case.
