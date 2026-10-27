# PARKED

Items that could not be finished with the evidence available, with the exact
reason and the exact next step that would unblock them. Nothing here is a
guess dressed as a finding.

## Bug 1 — Local PDF shows black (parked 2026-10-27, bug-fix round)

User report: opening `Downloads\Diploma_Document_30-Jul-2026_04_33.pdf` with
Open file opened the viewer, the top bar said "file", and the whole page was
black. The user's actual file was NOT read (privacy).

What six off-screen runs on the laptop proved (all Medium Mandatory Level,
E2E window shown but positioned off-display, as the user requires):

- The viewer HTML loads with the correct filename title, and the app
  navigates to the viewer URL, never the `/file` URL (no rewriting anywhere).
- The `/file` bytes serve HTTP 200, byte-exact, with the fixed mime.
- A request log inside the protocol handler proved the viewer request AND
  the `/file` request both reach the handler and return 200 — for the PDF
  embed, the text iframe, and a direct `/file` navigation. Delivery works.
- Returning a complete buffered body instead of a stream changed nothing
  (identical pixel numbers). The streamed-body theory is dead, and the
  buffering change was reverted, not shipped.
- An http-only discriminator proved the capture method itself is blind:
  a top-level http text document paints bright (mean luma 254.6), while
  an http sandboxed-iframe text document (29.96), an http plain same-origin
  iframe (29.95), and an http PDF embed (31.96) all capture dark. A valid
  white PNG `<img>` paints exactly 255, so images are fine — the blindness
  is specific to iframe documents and plugin embeds. It is
  scheme-independent (http shows it too) and process-model-independent
  (plain and sandboxed iframes both dark).
- Killed theories: navigation rewrite to `/file`; guard blocking the embed
  (guards admit local URLs verbatim); PDF-route interception (it requires
  mainFrame + https, so it cannot fire for a local embed); late paint
  (15 s captures unchanged); off-screen bounds (forced bounds, real
  layout, main frame paints).

Conclusion: in the off-screen E2E window, webContents captures show
main-frame content only. The local viewer puts ALL file content in a
subframe (PDF `<embed>`, text sandboxed `<iframe>`), so no E2E pixel test
can verify it — such a test would fail even for a correct viewer and was
deliberately NOT written. The visible-app cause is NOT proven by any run
so far: in a visible window, subframe and plugin content paints normally,
so the user's black page needs a visible-app cause that no off-screen run
can reproduce. No code change ships for this bug: the two investigation
seams (pixel capture, bounds, protocol log) and the buffering change were
all reverted, the seven diagnostic specs were deleted, and the tree is
back to a clean HEAD 0017e87.

Found but out of scope (not the user's symptom, needs separate
authorization): the store mirror can stick on "failed" with ERR_ABORTED
while the registry is "ready" (loadURL's promise rejects when superseded).
The surface renders the load-error block OUTSIDE the native view host, so
it would be visible above a dark view — the user reported no error text.

What unblocks this (user visual check, in the app he runs):
1. Does the same diploma PDF open in Chrome or Edge's own PDF viewer?
2. Does a small test PDF (any ordinary 1-page PDF) open in the app's
   viewer, or is it black too?
3. The diploma file's size and page count, and whether it is a scanned
   image-only PDF.
If (1) opens but (2) is black, the fault is app-wide and worth a new
authorized round. If (1) is also black or broken, the fault is in that
file, not the app. If (2) opens fine, the fault is specific to the
diploma file's structure or size.
