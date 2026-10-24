# Protected CF-Sequential corpus discrepancy

## Read-only finding

The protected CF-Sequential corpus was not mutated, recreated, deleted, or substituted during the CareerFlow browser recovery work. The forbidden historical binding was not used as a launch target.

The active Donut profile count is intentionally treated as a persistent corpus, not a fixed test baseline. The latest Phase 8 gate recorded `preTotal=188` and `afterRepeatTotal=190`, proving the test added exactly two profiles relative to the observed baseline and did not globally clean the corpus. A read-only inspection of the active CareerFlow workspace found the browser row for CareerFlow profile `76` with local id `680d2487-e58f-477a-9191-664b7d6e1988`; the corresponding machine-local binding entry still points at the historical Donut UUID `34ee7822-7970-4ac7-963c-aac4daeb8ee1`. The protected local id `1dad94c2-9999-4a67-886c-a4ff2270a104` has no entry in the active binding store, and the active binding store contains exactly one key. No remapping was performed. This is evidence of a stale historical mapping plus a missing active protected binding entry, not evidence that the protected corpus is absent everywhere.

The latest read-only Donut listing still does not establish that the active data root contains the protected historical corpus. No conclusion is drawn that the historical corpus never existed; it may reside in another data root, historical workspace, backup, or artifact that is not part of the active runtime. The discrepancy remains unresolved by design because resolving it safely would require identifying an authoritative source without mutating any protected data.

## Ownership/mapping model

CareerFlow stores managed-browser metadata in SQLite and machine-local Donut UUID bindings in `donut-bindings.json`. The Donut profile UUID is deliberately absent from portable CareerFlow profile metadata. Browser launch validates the CareerFlow owner first and resolves the machine-local binding through the main-process mapping layer.

## Required follow-up

Before any operation involving a protected profile, reconcile the authoritative Donut profile listing, CareerFlow SQLite browser-profile rows, runtime descriptors, actual profile roots, process command lines, and historical artifacts. A profile must never be selected merely because its name, directory, or UUID resembles the protected corpus.

No cleanup, reset, migration, remapping, or profile creation should be performed as part of this discrepancy investigation.
