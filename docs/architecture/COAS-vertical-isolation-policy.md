# COAS Vertical Isolation Gate

## Purpose

The COAS Vertical Isolation Gate is a platform-wide policy for the codeNXT platform. It applies across backend runtime, frontend UI, public API contracts, provider ingress, reports, dashboards, analytics, copy, tests, documentation, and operational readiness.

COAS is shared platform architecture, but every vertical must remain isolated in behavior, data, terminology, provider mapping, reward/category semantics, report contracts, and visible user experience. No vertical is pilot-ready until the isolation gate is green.

Later frontend repositories may link to this policy instead of duplicating it, but the policy itself is owned as a COAS platform rule.

## Isolation Layers

The gate must be evaluated across all platform layers:

- Brand.
- UI.
- API.
- Runtime.
- Persistence.
- Reports.
- Analytics.
- Providers.
- Redemption.
- Testing.
- Documentation.

A vertical can pass only when isolation is verified across every layer that the vertical uses.

## Gate Rule

A vertical is not pilot-ready until it has passed explicit isolation checks for:

- Event resolution.
- Scan routing.
- Reports and read models.
- Rewards and tiers.
- Redemption routing.
- Provider adapters.
- Public response shape.
- Visible copy across all supported languages.
- Documentation and ownership of its vertical-specific contract.

## Namespaces And Vertical Names

Each vertical must use its own stable vertical name and namespace.

Requirements:

- Runtime vertical names must be explicit and normalized.
- Event lookup must not fall back across verticals when a vertical is explicitly requested.
- Scan routing must resolve within the requested or stored vertical.
- Read helpers must support vertical-aware filtering when data tables are shared.
- Provider adapters must be registered under the correct vertical/provider namespace.
- Shared COAS concepts may be reused, but vertical-specific contracts must remain separate.
- The vertical must not be guessed from shared copy, shared reward names, generic event codes, or implicit runtime aliases.

## Brand Isolation

Brand isolation covers visible identity and language.

Requirements:

- Names must be vertical-specific.
- Logos must be vertical-specific.
- Iconography must be vertical-specific or explicitly shared platform iconography.
- Colors must not imply another vertical unless they are documented shared platform colors.
- Language and translations must be reviewed per vertical.
- Terminology must be owned per vertical.
- Marketing copy must not be reused across verticals unless it is explicit shared platform copy.

## Visible Copy And UI

Visible copy is part of the isolation contract.

Required copy surfaces:

- Hero.
- Checkout.
- Ready.
- Dashboard.
- Join.
- Claim.
- Report labels.
- Buttons.
- Placeholders.
- Alt text.
- PDF.
- CSV.
- Email.
- SMS.
- Push.

Requirements:

- No vertical may reuse visible copy from another vertical unless it is explicitly shared platform copy.
- Frontend surfaces must not mix product names, audience terms, reward names, or provider terminology across verticals.
- All languages must be checked for cross-vertical copy leaks.
- Backend responses that feed UI copy must follow the same vertical isolation rules.

## Routes And Provider Adapters

Routes and provider adapters must be isolated where vertical behavior differs.

Requirements:

- Use vertical-specific report routes where report contracts differ.
- Use vertical-specific provider adapters where provider payloads map to different domain behavior.
- Do not route provider payloads through another vertical's adapter as a shortcut.
- Providers produce Audience Entry only; provider adapters must not know rewards, reward assignment, redemption, or vertical-specific reward lifecycle.
- Do not expose provider-specific raw payloads or COAS internals in public responses.

## Reward And Category Isolation

Reward and category terminology is vertical-specific.

Requirements:

- Categories must be owned by one vertical unless reuse is documented through an explicit compatibility layer.
- Reward names must not leak across verticals.
- Reward rules must be scoped to the owning vertical.
- Reward lifecycle must be scoped to the owning vertical.
- There must be no cross-vertical reuse of reward/category semantics without an explicit compatibility contract.
- codeClip terminology must not appear in codePod public responses or UI copy.
- codePod terminology must not appear in codeClip public responses or UI copy.
- Tier values used as internal technical selectors must not be treated as visible product copy.
- Reward fields must be interpreted only inside the owning vertical's public contract.

## Public API Contract Isolation

Each vertical must define allowed and forbidden public fields.

Public responses must only expose fields allowed by that vertical's contract.

Forbidden in public responses for all verticals:

- `audienceEntry`
- `audienceIntent`
- `audienceContext`
- raw Interaction objects
- `stateTransitions`
- `routingOutcome` unless explicitly public for that vertical
- `rewardAssignmentSnapshot`
- `persistenceStatus`
- `persistenceDecision`
- `persistenceGuaranteePolicy`
- `persistenceAction`
- raw provider payloads
- internal recovery payloads
- outbox payloads
- state machine internals

Allowed fields must be documented per vertical before pilot.

## Runtime Isolation

Runtime isolation covers COAS and vertical-specific runtime behavior.

Required runtime checks:

- Event resolution.
- Audience Entry.
- Interaction.
- Routing.
- Reward Assignment.
- Persistence.
- Reports.
- Redemption.
- Analytics.

Requirements:

- Runtime must not guess a vertical when a vertical is explicit.
- Runtime must not cross-resolve shared event codes.
- Runtime must not reuse another vertical's reward assignment flow.
- Runtime must not expose COAS internals in public responses.

## Event Resolution Isolation

Event resolution must use `eventCode + vertical` when vertical is explicit.

Requirements:

- Never resolve by `eventCode` alone for explicit vertical requests.
- `/event` lookup must filter by vertical when vertical is provided.
- `/scan` lookup must filter by vertical when vertical is provided or stored on the event.
- Colliding event codes across two verticals must not cross-resolve.

## Data And Database Isolation

Shared tables are allowed only when queries are vertical-aware.

Requirements:

- Shared tables may exist.
- Queries must filter by vertical when the table contains multiple verticals.
- Persistence must record vertical where shared storage is used.
- Read helpers must preserve vertical filtering.
- Database migrations and indexes must not create implicit cross-vertical aliases.

## Report Isolation

Reports and read models are public-facing contract surfaces.

Requirements:

- Report queries must use `event_code + vertical` when data can be shared across verticals.
- Read helpers must filter by vertical.
- Reports must not contain mixed rows or mixed metrics.
- Report fields must belong to the report's vertical contract.
- Legacy report aliases must be explicit compatibility fields, not implicit cross-vertical reuse.

## Redemption Isolation

Redemption routing must be explicit.

Requirements:

- Redemption tokens must have clear prefix/routing rules.
- Prefix fallback must not route one vertical's token into another vertical's redemption flow.
- Redemption validation and redeem endpoints must not infer another vertical from shared token shape.

## COAS Internal Isolation

COAS internal objects are not public contracts.

Internal objects include:

- AudienceEntry.
- AudienceIntent.
- Interaction.
- RoutingOutcome.
- AudienceContext.
- RewardAssignment.
- PersistenceDecision.
- Outbox.
- State Machine.

Requirements:

- These objects may be shared inside COAS architecture.
- They must not be exposed publicly unless a vertical explicitly defines a public-safe projection.
- Internal object names must not be confused with provider analytics metrics.
- Internal state must not leak through reports, dashboard payloads, provider responses, or redemption responses.

## Frontend Isolation

Frontend isolation is mandatory for pilot readiness.

Requirements:

- No cross-vertical copy.
- No cross-vertical reward/category terminology.
- All languages checked before pilot.
- Shared UI components are allowed.
- Shared semantics are forbidden unless explicitly documented as platform semantics.
- A shared component must receive vertical-specific copy, labels, alt text, reward names, and report labels.

## Shared Components

Shared implementation is allowed only when semantics remain isolated.

Requirements:

- Shared UI components are allowed.
- Shared backend utilities are allowed.
- Shared COAS runtime concepts are allowed.
- Shared semantics are forbidden unless they are explicit platform semantics.
- Shared code must not create implicit cross-vertical aliases.

## Legacy Compatibility

Legacy compatibility must be explicit.

Requirements:

- Legacy compatibility is allowed only through an explicit compatibility layer.
- There must be no implicit runtime aliasing.
- Legacy fields must be documented as compatibility fields.
- Compatibility must not hide cross-vertical leakage.

## Test Requirements

Every vertical entering pilot must pass isolation tests that include at least two verticals sharing the same `eventCode`.

Required collision tests:

- Event collision.
- Report collision.
- Scan collision.
- Reward collision.
- Copy collision.
- Translation collision.
- Provider collision.
- Redemption collision.
- Dashboard collision.
- Hero collision.
- Checkout collision.
- Join collision.
- PDF collision.
- CSV collision.
- API collision.
- DB collision.

Additional required checks:

- `/event` isolation with the same event code in two verticals.
- `/scan` isolation with explicit vertical and colliding event code.
- `/report` isolation so rows, metrics, and reward fields do not mix.
- Reward, tier, and category terminology must not leak across verticals.
- Redemption prefix routing must not fall back to the wrong vertical.
- Public responses must not expose COAS internals.
- Hero, checkout, dashboard, join/claim, report labels, and all supported languages must be checked for vertical-specific copy.

## CI Gate

The COAS Vertical Isolation Gate must be enforced in CI.

Requirements:

- A PR cannot merge if the Isolation Gate fails.
- New verticals must add isolation tests before runtime activation.
- Existing verticals must keep isolation tests green before pilot deploy.
- Documentation coverage for this policy must remain tested.

## Onboarding Rule

Before a new or existing vertical is connected to COAS runtime, the isolation gate must be filled out and tested.

Minimum onboarding checklist:

- Namespace.
- Routes.
- Rewards.
- Reports.
- Copy.
- Providers.
- Redemption.
- Tests.
- Documentation.
- Isolation gate green.

A vertical can reuse COAS core architecture only after its isolation contract is explicit and tested.

## Canonical Ownership

Each vertical must define canonical ownership for:

- Terminology.
- UI copy.
- Reward categories.
- Report contract.
- API contract.
- Test data.
- Documentation.

Reuse requires an explicit compatibility contract. Without an explicit compatibility contract, reuse is treated as a leak.
