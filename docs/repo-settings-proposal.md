# Repository settings proposal for burin-labs/homebrew-burin

This file proposes changes. It does not apply them. Repository and
organization settings are the founder's to change, so treat every item below
as a recommendation waiting on a decision.

Written during the org-wide repository hygiene sweep on 2026-09-01.

## What this repository is

`homebrew-burin` is the Homebrew tap for Burin Code, the `burin` CLI, and the
Harn runtime. It has to stay public: `brew tap burin-labs/burin` reads it over
an anonymous clone, so a private tap cannot serve an install.

It is more active than the connector repositories in this sweep. Formula bumps
land most days, and the open issues are real packaging defects rather than
placeholders. It is a live distribution channel with real, if pre-launch,
users.

## Proposals

### Keep issues on

No change proposed. Unlike the connector scaffolds in this sweep, this
repository has genuine open issues about packaging behavior, and a user whose
`brew install` fails has nowhere better to go. `CONTRIBUTING.md` routes app
and runtime bugs upstream and keeps tap bugs here, which is the split that
matches where the fix lands.

### Leave discussions off

Discussions are already off. Keep them off until launch. There is no one
staffed to answer, and an unanswered discussion reads worse than an absent
one.

### Require approval before fork pull requests run workflows

A public tap accepts a pull request from any fork, and each one spends hosted
runner minutes on CI before a human looks at it. This repository does not
accept external contributions.

Proposed: require approval for all outside collaborators under the Actions
fork pull request workflow policy. This is the narrowest control that stops
the spend without hiding the repository or blocking the release bot, which
pushes branches directly rather than from a fork.

Cost if wrong: an outside patch waits for manual approval before its checks
run. Given the contribution policy, that is the intended behavior.

### Protect the generated formula paths from direct edits

`Formula/*.rb` and `Casks/*.rb` are generated. A well-meaning direct edit is
silently reverted by the next release bump, which wastes the editor's time and
can look like the fix regressed.

Proposed: add a CODEOWNERS entry covering `Formula/` and `Casks/` so a change
to a generated file requires an explicit review rather than passing as an
ordinary edit. This is a repository file change, not a settings change, but it
needs the same ruling because it constrains who can land what.

Cost if wrong: an urgent hand-patch to a formula needs one review. Given that
the next bump overwrites it anyway, that review is worth having.

## Not proposed

- Making the repository private. A private tap cannot serve `brew tap`.
- Archiving. The release bot pushes here most days.
- Turning off issues. See above. This repository has real ones.
