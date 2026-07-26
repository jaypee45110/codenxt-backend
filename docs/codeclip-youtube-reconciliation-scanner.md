# codeClip YouTube reconciliation scanner

## Purpose

The codeClip YouTube reconciliation scanner is a read-only operational tool for finding published YouTube videos that should have produced provider-event deliveries but are missing from the delivery ledger.

WebSub remains the fast primary signal. The scanner exists because upstream WebSub notification non-delivery has been reproduced, so periodic reconciliation is needed for deterministic missing-upload detection.

## Read-only guarantee

This scanner does not create provider deliveries, invoke the interaction pipeline, assign rewards, redeem ClipXtra, renew WebSub subscriptions, unsubscribe, create diagnostic probes, mutate bindings, write PostgreSQL rows, or mutate Redis.

It only reads eligible bindings/subscriptions, reads recent uploads from the configured source, and looks up existing delivery identities.

## Source selection

Current executable source: public YouTube Atom feed.

Preferred future source: YouTube Data API uploads playlist. The repository currently has YouTube OAuth/WebSub configuration, but no dedicated Data API key variable or uploads-playlist client foundation.

Relevant environment-variable names:

- `DATABASE_URL`
- `CODECLIP_YOUTUBE_WEBSUB_SECRET`
- `CODECLIP_YOUTUBE_OAUTH_CLIENT_ID`
- `CODECLIP_YOUTUBE_OAUTH_CLIENT_SECRET`
- `CODECLIP_YOUTUBE_OAUTH_CALLBACK_URL`
- `CODECLIP_YOUTUBE_OAUTH_RETURN_URL`
- `CODECLIP_YOUTUBE_OAUTH_STATE_SECRET`

Do not print or log variable values.

## Command examples

```sh
node scripts/codeclip-youtube-reconciliation-scanner.js --json
node scripts/codeclip-youtube-reconciliation-scanner.js --channel-id UCvwiNkgNuGuizjo33NZhzPg --lookback-hours 72 --json
node scripts/codeclip-youtube-reconciliation-scanner.js --event-code CC-EVENT --source atom
```

The script prints `Mode: READ-ONLY` in human output. JSON output has `mode: "read_only"`.

## Output interpretation

Important candidate classifications:

- `missing`: no delivery exists for the YouTube delivery identity.
- `existing_completed`: a completed delivery exists.
- `existing_incomplete`: a delivery exists but is not in the completed invariant state.
- `existing_failed`: a failed pre-commit delivery exists.
- `excluded_before_activation`: upload is not eligible under the activation boundary.
- `invalid_candidate`: source upload could not be safely normalized.

The missing list is the future worker input. This scanner does not submit it.

## Activation boundary

The scanner uses the existing WebSub notification semantics: uploads with `publishedAt <= activationBoundaryAt` are excluded, and uploads with `publishedAt > activationBoundaryAt` are eligible.

The scan is also bounded by `--lookback-hours`, defaulting to 72 hours, so it does not perform unbounded historical channel scans.

## Known limitations

Atom feeds are limited to recent public entries and are best-effort as a read source. The scanner is structured so a later Data API adapter can replace or augment Atom without changing target discovery or delivery comparison.

The next step is a write-enabled reconciliation worker that takes `missing` candidates and submits them through the existing provider delivery and interaction pipeline with explicit operational controls.
