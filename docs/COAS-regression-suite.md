# COAS Regression Suite

This document describes the controlled multi-vertical regression runner. It is
an operational test entry point, not a new COAS architecture specification.

## Purpose

The suite verifies shared COAS behavior while preserving each product
vertical's own routes, payloads, terminology, and runtime contracts. Standard
execution is sequential and uses local backend tests, mock-based browser tests,
and source-policy guardrails. It must not write to production services.

## Standard Suite

Run from the backend repository:

```bash
cd /Users/jan/event-platform/codenxt-backend
bash scripts/run-coas-regression.sh
```

The standard suite contains:

- All backend Node tests and a `server.js` syntax check.
- Frontend builds for every included frontend repository.
- codeDemo local COAS regression through `playwright.coas.config.js`, using a
  local Vite server and Railway catch-all mocks with no production frontend.
- codeTone mock regressions for its product journey and exclusive
  PrintPoster/Screen Video runtime.
- codePerks mock regressions for campaign creation, dashboard, join, scan, and
  rewards.
- codePage and codeStack mock product-journey regressions.
- The codePod Screen Video/Print containment guardrail.
- The codeClip frontend vertical-isolation guardrail and production build.

The runner verifies each repository with a repo-specific marker and checks all
required test files before execution. It reports the current branch and short
Git status for every repository. Non-Git directories are reported but do not
make the suite fail. The runner does not install dependencies.

One command runs the whole standard package:

```bash
cd /Users/jan/event-platform/codenxt-backend
bash scripts/run-coas-regression.sh
```

Here, the whole standard package means the full backend test package,
hermetic/mock-based frontend regressions where they exist, and the
containment/isolation guardrails for codePod and codeClip.

Use `--continue` to run every standard step and report all failures:

```bash
bash scripts/run-coas-regression.sh --continue
```

## Repository Locations and Ports

| Vertical | Repository | Local port |
| --- | --- | ---: |
| Backend | `/Users/jan/event-platform/codenxt-backend` | Dynamic in route tests |
| codeDemo | `/Users/jan/event-platform/codedemo-deploy` | 5176 |
| codeTone | `/Users/jan/event-platform/codenxt-final-deploy` | 5177 |
| codePerks | `/Users/jan/event-platform/codeperks-deploy` | 5178 |
| codePage | `/Users/jan/event-platform/codepage-deploy` | 5179 |
| codeStack | `/Users/jan/event-platform/codestack-deploy` | 5180 |
| codePod | `/Users/jan/codepod-clean-filesafe` | 4173 |
| codeClip | `/Users/jan/event-platform/codeclip-deploy` | 4173 |

Before running tests, the runner checks these Playwright ports and warns when a
listener already exists. It does not stop or kill any process. Execution
remains sequential because codePod and codeClip share port 4173.

## Live and Staging Tests

Live execution is a placeholder and runs no live tests. The gate requires all
of the following:

```bash
COAS_LIVE=1 \
COAS_API_BASE=https://explicit-target.example \
COAS_ALLOW_PRODUCTION=1 \
bash scripts/run-coas-regression.sh --live
```

There is no default target. Setting these variables only opens the safety gate;
it does not configure or run live tests. Future live/staging tests must use the
explicit target, must not rely on production defaults, and must remain separate
from the standard suite.

Examples that must remain opt-in include production redemption, GoldXtra,
provider, and direct Railway API tests.

## Failure Handling

The script deliberately omits `set -e`. Each command is handled by `run_step`
so normal execution can stop cleanly at the first failure while `--continue`
can record failures, complete all remaining sequential steps, and exit nonzero
with a summary.

Existing working-tree changes in vertical repositories are not modified by the
runner. Review the reported Git status separately before interpreting or
committing test results.
