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

## Bug 3 — ChatGPT send shows "Unable to connect" (WAITING for real-screen evidence)

Seen on the real screen (2026-10-28 05:41 IST, build 0e6917e): ChatGPT loaded
in browser profile work1 (logged out). Sending "hi" showed "Unable to connect"
with a Retry button. Cause not proven. No work starts until the network log
evidence below is in.

Next step, on the real screen:

1. Go to Settings, then Diagnostics, and turn on Page network log.
2. Go back to the ChatGPT tab and send "hello" again.
3. Go to Diagnostics and press Refresh.
4. Send me a screenshot of the cards. If it says "No failed requests recorded
   yet", send that screenshot too.

How to read the log: docs/README_RUN.md ("Page network log" section).
