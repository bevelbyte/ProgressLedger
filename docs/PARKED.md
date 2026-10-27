# PARKED

Items that could not be finished with the evidence available, with the exact
reason and the exact next step that would unblock them. Nothing here is a
guess dressed as a finding.

## Bug 1 — Local PDF shows black (RESOLVED 2026-10-28)

Resolved in round 2026-10-28.
Real-screen testing proved that all PDFs (1-page, multi-page, and diploma)
showed solid black in the app viewer while the same diploma PDF opened cleanly
in Chrome.
Root cause: Chromium's built-in PDF viewer extension attaches inside an internal
subframe at `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/<stream-uuid>`.
The `will-frame-navigate` navigation guard previously checked `isAllowedUrl()`,
which refused `chrome-extension:` as a disallowed scheme and called
`event.preventDefault()`. This silently blocked the PDF extension from loading
inside `<embed>`, rendering 0 content pixels and displaying only the wrapper's
`#1e1e1e` dark background.
Fix: Added `CHROMIUM_PDF_EXTENSION_PATTERN` and `isAllowedFrameUrl` in
`shell/src/services/browser/policy.js` and wired `will-frame-navigate` in
`shell/src/services/browser/navigation.js` to allow Chromium's internal PDF
viewer extension in subframes, while keeping all top-level navigations and
address-bar targets strictly forbidden from extension schemes.
