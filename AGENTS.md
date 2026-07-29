# AGENTS.md

## Purpose

This repository contains the shared codeNXT backend and its strictly isolated
product verticals.

All coding agents must treat this file as mandatory project policy.

## Authoritative repository

Repository:

`/Users/jan/event-platform/codenxt-backend`

Primary branch:

`main`

Do not assume that another repository, branch, deployment, document, or previous
agent response is authoritative without verifying it.

## Mandatory workflow

Use this workflow for every implementation task:

1. Pre-flight
2. Read-only inspection
3. Scope confirmation
4. Proposed patch
5. Explicit approval when requested
6. Implementation
7. Focused tests
8. Relevant regression tests
9. Diff and status verification
10. Commit only when explicitly ordered
11. Deploy only when explicitly ordered

Do not skip directly to implementation when the task asks for inspection or a
proposal.

## Pre-flight requirements

Before changing files, report:

```bash
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
```

Confirm that the repository, branch, HEAD and working tree match the task.

Never silently continue after a material pre-flight mismatch.

## Local working tree protection

.DS_Store is a known local modification.

Never:

- edit it
- stage it
- restore it
- delete it
- include it in a commit
- use it as justification for cleaning the working tree

Do not modify unrelated local changes.

Do not use destructive Git commands unless explicitly ordered.

Prohibited without explicit instruction:

```bash
git reset --hard
git clean
git checkout -- .
git restore .
```

## Scope discipline

Modify only files required by the approved task.

Do not perform opportunistic refactoring.

Do not rename, reformat, reorganize or modernize unrelated code.

If another file must be changed, stop and explain:

- which file
- why it is necessary
- what the smallest change would be

Do not broaden scope without approval.

## Vertical isolation

codeNXT is the platform.

Product verticals are peers and must remain strictly isolated.

Examples include:

- codeClip
- codePod
- codeDemo
- codePerks
- codeTone
- codePage
- codeStack

Never make one vertical depend on another vertical's:

- names
- routes
- configuration
- runtime state
- persistence records
- Redis keys
- user-facing text
- provider behavior

Shared functionality must be genuinely platform-level and must not leak
vertical-specific semantics.

Do not treat codeClip as a universal reference product.

## codeClip terminology

Use Episode, not Campaign, in creator-facing codeClip surfaces.

Provider/channel configuration belongs primarily in Checkout.

Dashboard is primarily a read-only configuration and operational status
surface, not a duplicate setup interface.

## Persistence principles

PostgreSQL is the primary durable store.

Redis is used for caching, coordination, replay protection and other explicitly
defined transient behavior.

Do not treat Redis as the durable source of truth.

Critical persistence paths must fail closed when writes cannot be confirmed.

Do not report an operation as completed when required durable writes are
unconfirmed.

Preserve existing transaction boundaries and delivery-ledger semantics.

## Provider ingress and outbound security

Provider-specific security contracts must remain fail closed.

Never weaken:

- signature verification
- raw-body verification
- provider-account binding
- rate limiting
- idempotency
- replay protection
- delivery-ledger guarantees
- public-safe error handling

Never log or expose:

- provider secrets
- access tokens
- authorization headers
- raw personal identifiers
- unmasked provider account identifiers
- unmasked recipient identifiers

Use masking or fingerprints where existing contracts require them.

## Secrets

Never add real secrets to:

- source code
- tests
- fixtures
- documentation
- command output
- commits

Do not print environment-variable values.

It is acceptable to report whether a required variable is present, but not its
value.

## Runtime and schema changes

Do not add any of the following unless the task explicitly requires them:

- new routes
- server.js wiring
- background workers
- scheduled jobs
- database tables
- schema migrations
- Redis key families
- external HTTP calls
- provider API calls
- Railway services
- environment variables

Foundation tasks must remain isolated from runtime wiring when that is part of
their scope.

## Tests

Add focused tests for every behavior change.

Tests must cover:

- successful behavior
- invalid inputs
- fail-closed behavior
- idempotency where relevant
- terminal-state behavior where relevant
- masking and public serialization where relevant
- vertical isolation where relevant

Run the focused tests first.

Then run the smallest relevant regression set.

Do not spend excessive time fixing unrelated existing failures.

Clearly distinguish:

- implementation failures
- existing failures
- sandbox or environment limitations

Do not claim a test passed unless it was actually executed and passed.

## Network and deployment safety

Do not make real external requests unless explicitly authorized.

Do not call provider APIs merely to test connectivity.

Do not mutate production data without explicit approval.

Do not deploy unless the task explicitly says to deploy.

A request to implement, test, commit or review is not authorization to deploy.

## Git rules

Do not stage or commit unless explicitly ordered.

Before staging:

```bash
git diff --check
git status --short
```

Stage explicit file paths only.

Never use broad staging commands such as:

```bash
git add .
git add -A
```

Before committing:

```bash
git diff --cached --check
git diff --cached --stat
git status --short
```

After committing, report:

- commit hash
- commit message
- committed files
- test results
- final working-tree status

Do not push unless explicitly ordered.

## Approval model

When an approval interface is presented, approval is binary.

Yes, proceed means the displayed patch may be applied immediately.

Any correction, condition, added test, changed scope or new instruction requires
rejecting the proposed patch and supplying the correction.

Do not combine approval with additional instructions.

## Reviews

For read-only reviews:

- do not edit files
- do not stage
- do not commit
- do not deploy
- inspect actual repository code
- cite exact files and line ranges
- distinguish confirmed defects from optional improvements
- avoid proposing broad rewrites
- rank findings by severity and operational impact

A review with no material findings should say so clearly.

## Completion report

Every completed task must report:

- pre-flight result
- files inspected
- files changed
- behavior implemented
- focused test results
- regression test results
- git diff --check
- git diff --stat
- git status --short
- whether anything was staged, committed, pushed or deployed
- any unresolved risks or limitations

Never present planned work as completed work.
