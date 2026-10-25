# Run migration and external jobs on devinabox

Accepted by the owner on 2026-10-25. Arcane is permanently retired and will not return online. Use devinabox, the current development machine, for the Turso-to-D1 migration and the replacement daily Steam Status and hourly offer jobs. Do not wait for Arcane or make its recovery a migration prerequisite.

This supersedes only the Arcane host selection in ADRs 0002 and 0004. The website remains on Cloudflare, D1 remains the database target, and external jobs use the machine-authenticated Worker endpoint. Keep routine job credentials separate from Cloudflare operator credentials and retain normal CI deployment gates.

Use a new persistent Steel browser profile on devinabox. Do not assume the unavailable Arcane profile or its authenticated session was recovered. Preserve the browser-only login boundary; a new interactive Steam login may be required. Keep Steel private and retain the existing schedules and Steam Status safeguards.

Keep Turso and the protected local export for recovery. The owner accepts possible data gaps for later backfill and requested less test-only preparation; that does not guarantee that every stored value can be rebuilt or authorize deletion of Turso.
