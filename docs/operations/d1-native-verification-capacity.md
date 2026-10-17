# Bounded mixed-width native verification (#33)

This is the sizing and completeness argument for `estimateFixedD1Verification` and `scanFixedD1Tables`, not source-data acceptance, live execution authority or a deployed capacity certificate. The [fixed-job preparation boundaries](d1-fixed-job-remote-preparation.md) remain in force. Public transfer pages stay at 64 rows; only the separate internal complete verifier changes. Migrations, fixed-job APIs, import packing and native transaction guards are unchanged.

## Problem and evidence boundary

Historical aggregate-only source measurements recorded 84,249 games, 26,377 offer-cache rows and 13,575 ITAD mappings. The largest recorded offer scalar was 7,184 bytes. Those are not current/frozen rows, canonical manifest totals or content digests. Held #32 code sized every page from each table's single maximum, yielding a conservative 1,031-query estimate from even those lower-bound measurements. Its refusal was correct. The narrower #32 local fixture did not prove support for that distribution.

The new genuine local regression constructs all eight retained tables at those three large counts, narrow rows plus a valid wide synthetic offer JSON scalar, mixed NULL/integer/real/text storage, UTF-8/escaping, rowid gaps and deleted allocation high-water. Expected complete inventories are obtained through the unchanged public native scanner, not caller-supplied expected digests. The held code's real pre-bootstrap refusal, zero target queries/batches and subsequent actual native observations are retained in private evidence. No production rows are fixtures.

## Native projection byte charge

Let `d(i)` be the decimal digit count of zero-based column index `i`. Define the fixed charge for a table with `C` columns:

`O(C) = 64 + sum(i=0..C-1, 66 + 3*d(i))`.

A projected native record contains `transfer_rowid`, then `cI` (original value), `tI` (SQLite storage type), and `bI` (original SQLite byte length) for every column. The charge for one native row is:

`R = O(C) + 6 * sum(length(CAST(value AS BLOB)) for text/blob cells)`.

This bounds JSON encoding of the **projected record**, including metadata, not merely the exported scalar bytes:

- Three property keys/colons cost `12 + 3*d(i)` bytes; their separators cost at most three.
- A quoted storage type costs at most nine bytes (`"integer"`). A nonnegative safe byte-length integer costs at most 16 digits; NULL costs four.
- A finite JavaScript number's shortest JSON representation costs at most 25 bytes, including sign and the fixed/exponential notation boundary. NULL costs four. Text costs at most two quotes plus six bytes per original UTF-8 byte: ordinary UTF-8, quotes/backslashes, ASCII controls and escaped surrogate pairs all fit this bound. The 25-byte allowance also dominates the two quotes. Byte-array BLOB representations fit the same six-times allowance but are still unsupported, never accepted typed data.
- Thus each column needs at most `65 + 3*d(i) + 6*scalarBytes`; charging 66 leaves slack. The leading 64 covers braces, rowid key/value and row separation. This exceeds even a 25-byte pre-validation numeric rowid representation. Invalid storage/precision is still rejected.

No `json_object` serialization, SQL value coercion or numeric formatting is used as content verification. SQL `typeof` and byte-length projections accompany the original values. The existing scalar validator still rejects BLOBs, unsafe integers, nonfinite numbers and negative zero; UTF-8 byte equality detects decoding loss. `recordRow` still enforces the canonical row limit and computes the original typed record, digest and storage summaries.

The actual JSON projection is also measured after the real native read, independently of this proof, and must be at most **2,097,152 bytes**. Each candidate set and returned page has at most **256 rows**. Arrays reserve two bytes: the cumulative charge budget is `B = 2,097,152 - 2`; row charges already cover separators.

## Admission from complete canonical manifest metadata

For complete canonical records, each text's actual UTF-8 byte length is at most its JSON-encoded contribution to that record. All numeric/type/key overhead is already covered by `O(C)`; it does not rely on SQLite numeric-to-text formatting matching JavaScript. Therefore, for manifest row count `N`, complete newline-delimited canonical byte total `T`, and maximum canonical row bytes `L`:

`M = 6*L + O(C)` bounds each native row charge;

`S = 6*T + N*O(C)` bounds the sum of native row charges.

Using the **total** rather than `N*L` is what allows many narrow rows plus occasional wide offers. This remains intentionally conservative for JSON escaping but does not multiply a single outlier by every row. No average or raw historical scalar maximum is substituted for a complete canonical total. All arithmetic must be nonnegative safe integers. An unsupported single-row charge or query bound refuses before bootstrap/target access.

The host continues to verify the actual protected snapshot, every canonical row/group and manifest metadata through unchanged `verifyArtifact` and protected artifact readers. Reviewed digests pin those original artifacts; they do not prove content by themselves. Native complete comparison is still required.

### Compatible sizing-only construction contract

Before #33, the public fixed-job construction/sizing seam required counts and maxima, not consistent total-byte metadata. Existing genuine native fault tests deliberately construct subset/constraint jobs with modified counts and retained original byte summaries. Do not turn the new optimization into an incompatible artifact-validation requirement at this sizing-only seam.

A total is usable for the tighter bound only if it is a safe integer, at least the maximum, and no greater than `N*L`, with positive `L`. Otherwise charge **every requested row at the declared maximum**, `S = N*M`. Zero requested rows use zero total/max charge and one empty read. This is a conservative fallback, never an invented total, average, digest acceptance, fault-name exception or permission to import unverified source data. It can refuse more work; it cannot justify a smaller upper bound than the declared maxima allow. Overflow/overbudget still refuses. Actual protected on-disk validation remains strict and byte-unchanged, while runtime recomputes actual bounds regardless of this path.

## Complete-page query bound

Runtime independently obtains native `COUNT`, `MAX(R)` and `SUM(R)` for every table. It rejects unsupported arithmetic or `M > B`, and budgets **all** tables before paging. Each query selects a bounded ordered keyset candidate of at most 256 rows, computes cumulative row charge using an SQL window, and returns only the prefix whose cumulative charge fits `B`. Every row charge is positive. A row exceeding the observed maximum triggers a native error rather than an oversized projected response.

Every non-final nonempty page can be classified:

1. **Row-limited:** it contains exactly 256 rows; there can be at most `floor(N/256)` such pages.
2. **Byte-limited:** it contains fewer than 256 and omits a next row. Its charge plus the next row exceeds `B`. Since that next row is at most `M`, this page's charge is strictly greater than `B-M`. At most `floor(S/(B-M))` such pages can occur. Row-limited pages are not also charged to this cause.

Allow one final nonempty page and one final empty page. For `M < B`, a conservative complete-read bound is:

`P = min(N+1, floor(N/256) + floor(S/(B-M)) + 2)`.

The independent `N+1` bound follows because every nonempty page advances at least one row. It also handles `M = B` without division by zero: use `P = N+1`. Empty tables use `P = 1`. This covers exact row-limit multiples, a final byte-limited page, a single wide row, and the mandatory final empty query. A short byte-limited page is **not** a completeness signal.

Each table uses one initial and one final native bounds query, so admission is:

`64 + sum(2 + P) <= 960 < 1000`.

The **64 reserved queries**, **960 admitted queries**, **1,000 Paid queries**, **256 rows**, **2 MiB** and existing **45,000ms** timeout literal remain unchanged. Reserved queries cover the existing schema/descriptors/ledger/sequence and bounded sequence transaction work; actual Worker `raw` calls and every native batch statement are counted by the genuine binding observer in tests. No HTTP adapter is cast as D1, and no cap is raised.

## Independent runtime fences and complete reconciliation

Runtime uses its own actual native `N/M/S`, not the manifest distribution. It enforces both the absolute scan query ceiling (`960-64`) and its tighter planned ceiling. Every scan query is awaited. Elapsed time is checked before and after the native operation against the existing 45-second budget; a slow completed read fails rather than dispatching more work. This is not a claim of cancelling SQL already executing.

For every returned typed row, the verifier recomputes charge from the checked text values, enforces strict rowid progress, count/max/cumulative-byte bounds and the original canonical record limit, and hashes the complete ordered original record. It stops only on an empty page within the proved finite page count. Final native count/max/sum must equal the initial bounds and the consumed row count/charge. Growth, shrinkage, unexpected sizes, an unbounded tail, exhausted queries or elapsed time stops verification before sequence reconciliation. A native error is not a rollback claim for any earlier import group.

Aggregates are never content acceptance. The unchanged Worker still compares the complete ordered typed inventory, every rowid/content digest/storage summary, full schema objects/xinfo/index/FK/table descriptors, excluded metadata, immutable migration ledger and complete sequence. Same-count/same-size changes remain visible to the final typed digest comparison. Sequence mutation retains native expiry/order/schema/progress guards, at most 64 total statements/63 data statements, and all unknown-write/receipt/protected-publication contracts.

## Characterization and acceptance

New genuine native controls cover byte-limited Unicode/NUL/quote prefixes followed by full row-limited pages and final empties, near-budget single-wide rows, unsupported single-row work before any target query/batch, and same-count scalar-byte growth after a real page before sequence mutation. Old unsupported-wide/query-budget, growth, typed/schema, public64-page, native rollback/group, remote transport and protection tests remain byte-identical.

One failed development packet remains a failure: a sizing-contract regression blocked three old native fault seams, and an external evidence harness's inherited `077` umask masked two deliberate `0644` negative fixtures. The authorized same-owner correction preserves the original packet, restores conservative sizing compatibility, and isolates evidence creation from the measured ordinary app umask (`002`). A real public-guard sentinel verifies exclusive private `0600` evidence, accepted `0600` inputs and genuinely `0644` refused inputs without chmod/adoption. No old test, guard or configuration is weakened.

Only three entirely new serial complete unfiltered clean-environment processes at one unchanged final candidate, all seven normal type projects/changed-file coverage, normal build, comment policy plus 13 regressions, configured scans and actual normal commit hooks constitute local acceptance. Protected handoffs record exact results, not this document. Independent merger/reviews and all real source/auth/native/cloud/rehearsal/cutover gates remain separate; production stays Turso until separately approved and verified.
