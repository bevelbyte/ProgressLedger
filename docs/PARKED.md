# PARKED

Items that could not be finished with the evidence available, with the exact
reason and the exact next step that would unblock them. Nothing here is a
guess dressed as a finding.

## Bug 1 — Local PDF shows black (FIXED, confirmed on real screen 2026-10-28)

Confirmed fixed on the real screen (2026-10-28): the user opened PDFs in build
7261013 and they display correctly.

Proven cause: the navigation guard blocked Chromium's built-in PDF viewer (it
loads as a `chrome-extension://` page), so only a black background showed.
Fix: commit 7261013 (lets that one viewer load; other extension pages stay blocked).
