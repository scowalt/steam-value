# D1 credential ownership and distribution

Names only. Production uses D1 after the 2026-10-31 accepted cutover; [#27](d1-integrated-rehearsal.md) is historical preparation evidence. Turso and the original export were removed under [ADR 0007's owner-approved exception](../adr/0007-retire-turso-after-owner-approved-early-cutover-acceptance.md). Read [contract v1](d1-access-contract.md) and the [cutover record](d1-cutover.md) before further credential or recovery operations.

## Distribution after separately approved cutover

| Name/capability | Worker | External jobs/manual tools | Approved operator only |
| --- | --- | --- | --- |
| `DB` native binding / non-secret D1 ID | Yes, fixed Steam Value binding | No selectors or direct D1 REST | Explicit bootstrap/transfer target |
| `STEAM_VALUE_DB_URL` | Not required | Required full HTTPS exact `/api/internal/db`, no userinfo/query/fragment | Approved application verification |
| `STEAM_VALUE_DB_TOKEN` | Selected Worker secret | Required separate application bearer | Protected provisioning/rotation |
| `STEAM_VALUE_ACCESS_CLIENT_ID` | No | Required Access service credential | Protected provisioning/rotation |
| `STEAM_VALUE_ACCESS_CLIENT_SECRET` | No | Required Access service credential | Protected provisioning/rotation |
| Access service-token **resource UUIDs** (`steam_value_access_service_token_ids`) | Edge policy only | Not runtime credentials | Non-secret mission-control input; not the Access client ID |
| `STEAM_API_KEY`, `STEAM_ID` | No | Steam Status/catalog/ownership tools as before | Approved provider verification |
| `STEAM_LOGIN_SECURE` | No | Historical manual exported-cookie tools only | Never export from Steel for migration |
| `ITAD_API_KEY` | No | Offer service only | Approved provider verification |
| `CLOUDFLARE_ACCOUNT_ID`, Worker-scoped `CLOUDFLARE_API_TOKEN` | Deployment environment, not runtime | Never | Existing scoped application deployment capability |
| D1/Access/subscription/backend administration | No runtime secret | Never | Separate explicit provisioning/migration capability; do not broaden Worker Editor |

The deleted source's `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are retired names, not configuration requirements. The gated publisher removes only those secret bindings from the existing Worker, preserves all other secret names and checks current main before each deletion. After verified deployment, remove matching obsolete values from this application's Doppler configs; never treat template edits as proof of remote deletion. Historical APIs/fixtures and the explicit supplied-handle transfer adapter do not require stored Turso credentials.

Doppler stays the source of truth. `.env.example` and the devinabox examples contain **blank names only**; Arcane examples are historical. Keep environment directories owner-only (0700), files owner-only (0600), and exclude them from Git. Do not put credentials in command-line arguments, issue text, logs, plan/state outputs, HTTP traces, screenshots or frontend assets. Avoid shell tracing and printing environments/headers. Protected snapshots/manifests/receipts may also be sensitive even when values look like game data.

## Authorized provisioning sequence (not preparation commands)

1. Record approval for any new credential/Access/resource operation and identify the correct Doppler configuration and account. `dev` is not evidence of isolation. The original provisioning and live-access checks are recorded in #28; do not repeat them or create replacement resources as housekeeping.
2. Provision a **dedicated Steam Value** Access service token through an approved protected operator workflow, keeping generated client ID/secret directly in Doppler. Pass only its non-secret resource UUID to mission-control. Do not create/import a Terraform token resource or data source that persists the secret in state; do not allow any-valid-service-token, viewer selectors or Bypass on the machine path.
3. Provision the separate application bearer in Doppler. Distribute only `STEAM_VALUE_DB_TOKEN` to the Worker at the coordinated stage. `scripts/cloudflare-secrets.ts` selects only that name; `secrets:dev`, `web`, `worker:dev` and `secrets:sync` are credential-download/upload operations, **not isolated setup commands**. They were not run in preparation. A protected operator must verify the chosen configuration and destination before using any convenience wrapper; the checked-in wrapper currently selects Doppler `dev` explicitly.
4. Distribute the four external database keys and only applicable provider keys to protected devinabox/manual environments while affected writers remain frozen. Steel's HttpOnly cookie stays in the existing persistent profile; do not place it in Doppler, Cloudflare, the offer environment or the scheduled status environment.
5. Verify Access Service Auth **and** Worker bearer rejection/acceptance separately using a protected probe that never logs headers/parameters. Client requests reject redirects; a viewer login redirect is a failure, not permission to forward credentials. Verify actual root/machine path precedence and disabled workers.dev/preview routes. Local fixtures prove bearer behavior, not Cloudflare edge policy or actual permission.
6. Preserve recovery capabilities until their applicable owner decision. For this migration, the owner explicitly approved early Turso/export retirement and subsequent credential housekeeping. Do not assume that decision authorizes deletion of D1, application/provider credentials, another database or historical audit records.

Rotation/revocation requires coordinated review: freeze affected writers, replace the bearer in Worker and external environments coherently, explicitly selected resource UUIDs may overlap for an approved Access rotation, verify dual authorization, then revoke the old capability. There is no automatic fallback/dual-writing, broad account-token substitution or retry after an unknown write. For an uncertain result, use the [persisted-state reconciliation procedure](d1-refresh-jobs.md#uncertain-writes) before resuming.

## Local verification boundary

Use sanitized environments and `bun --no-env-file` for tests/build/rehearsal. The real-local-D1 harness constructs synthetic four-key configuration and injects transport to the actual bundled Worker; it contacts no public synthetic origin or provider. Local bootstrap/admin/transfer commands discover no credentials. `db:inspect --application` is read-only but still **remote data access requiring approval**. Do not run it during preparation.

Secret scanning and browser/Worker bundle inspection are preparation evidence only; they cannot establish deployed credential scope, installed file permissions or production secret absence. Those remain #28 checks.
