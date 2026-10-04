# AGENTS.md

## Pull request titles

Use `[Area] Sentence case`. The area is one of `Formula`, `CI`, or `Docs`.

- `[Formula] Use pkgshare in the generated burin formula`
- `[CI] Stop reporting green on a head-only formula smoke`
- `[Docs] Say which install channel is gated before launch`

Keep the title on one line, under about 70 characters. Say what changed, not
which files moved. Capitalize the first word after the bracket and leave the
rest in sentence case.

`CONTRIBUTING.md` states the contribution policy for this repository.

<!-- BEGIN HARN SHARED AGENT CONTRACT: managed by harn-bump-fleet -->

## Ecosystem working agreement

- Pursue the ambitious product outcome; make the seams boring with small typed
  interfaces, explicit invariants, and deterministic projections.
- Give each behavior one semantic owner. Generate or parity-test other surfaces
  instead of maintaining competing implementations.
- Work autonomously inside approved scope. Pause for destructive, production,
  high-spend, ambiguous, or authority-expanding actions—not routine reversible work.
- Treat stop, wait, stand down, and pivot as control events for long-lived work.
- Match evidence to the claim. Use the smallest owning product-path check;
  add a falsifier for contested, load-bearing, or potentially vacuous claims.
  Record relevant controls, recovery, and blind spots without repeating proof.
- Evidence follows source and artifact identity, not the branch name. Reuse
  verified branch or merge-candidate evidence after landing when relevant code,
  build inputs, and dependencies are unchanged. Repeat affected checks only
  for a relevant change, observed failure, deployment, or packaging difference.
- "Ship" means integrated on owning main with terminal integration checks and
  applicable release or deployment checks complete. Confirm the landed change
  and merge result; do not rebuild or recapture screenshots solely for main.
- Ship a ready PR by adding the `ship` label when the repo has a Smart Ship
  caller (`.github/workflows/smart-ship.yml`); otherwise land through the merge
  queue with `gh pr merge --squash --auto`. Never `gh pr merge --admin`.
  Incidents use the org override labels `bypass-ci`, `bypass-merge-queue`, or
  `force-merge`.

<!-- END HARN SHARED AGENT CONTRACT -->
