# Security policy

## Reporting a vulnerability

Email **security@harn.cloud** with the details. Encrypt with our public key if
the report contains exploit material (key available on request).

Please include:

- a clear description of the issue and the impact (e.g. install-time RCE,
  formula/cask redirection, supply-chain tampering)
- a minimal reproduction (release manifest excerpt, malicious tap snippet,
  etc.)
- any affected versions of the Formula, Cask, or generator script
- whether the issue has been disclosed publicly or to other parties

## Response window

We aim to:

- acknowledge new reports within **2 business days**
- triage and confirm (or dispute) within **5 business days**
- ship a fix or mitigation within **30 days** for confirmed issues, faster for
  actively-exploited or user-facing supply-chain bugs

## Scope

In scope:

- the Homebrew tap (`Formula/`, `Casks/`)
- the generator script (`script/update-from-release.mjs`)
- CI workflows (`.github/workflows/`)
- any release artifact URL or sha256 mismatch that would let an attacker ship
  unintended code to `brew install burin` or `brew install --cask burin-code`

Out of scope (report to the appropriate upstream):

- vulnerabilities in Homebrew itself -> https://github.com/Homebrew/brew/security/policy
- vulnerabilities in the Burin Code application or `burin` CLI ->
  https://github.com/burin-labs/burin-code/security/policy

## Coordinated disclosure

We support coordinated disclosure. Please give us the response window above
before publishing details. We will credit reporters in the release notes for
the fix unless asked otherwise.
