# Progress Ledger v2 — site compatibility

Probed 2026-10-27 on the laptop, in the app's own browser views and in a
bare Electron window with default settings (same Electron version,
44.9.3). All runs used throwaway test data folders, hidden/off-screen
only. App views are not DOM-readable from the test harness (there is
deliberately no debugging endpoint), so app-view rows report what the
app itself records for the page: URL, title, state, and last error.
Engine rows ran in the bare window, where the page could be read
directly. "Works" means the site behaved as a user would expect.

## Table

| Site | Result | Why (evidence) |
|---|---|---|
| example.com | Works | App view: loads in ~2 s, title "Example Domain", state ready, no error. |
| Wikipedia | Works | App view: article loads in ~2 s, title "Computer - Wikipedia", no error. |
| GitHub | Works | App view: homepage loads in ~2 s with the GitHub title, no error. |
| Google search | Partly | Google redirects the search to its /sorry "unusual traffic" check instead of showing results; the original navigation reports ERR_ABORTED from that redirect. No app error is involved. The trigger (embedded UA vs traffic heuristics) was not isolated — the user's Brave browser was not tested, per the task rules. |
| YouTube (video and sound) | Works | App view loads the video page with the correct title. Engine window: the video plays (1280 px wide, readyState 4, no video error) and its audio track decodes (133,485 audio bytes decoded). The probe's own click paused playback at 8.43 s, so the "time advancing" check after that click is an artifact, not a failure. Speaker output itself cannot be verified off-screen. Codec note: YouTube served a playable stream here; Electron's bundled ffmpeg lacks some proprietary codecs, so an H.264-only stream elsewhere may fail — that limit was not probed here. |
| PDF opened in the browser | Fails | The PDF bytes arrive correctly (content-type application/pdf, no error, no download), but the built-in viewer never renders: after 30 s of polling, the viewer attaches zero elements, the tab title stays empty, and a page capture times out. The user would see a blank page, not the document. This was probed off-screen per the task rules; a visible window was not tested. (The first probe used a public W3C PDF URL that turned out to be dead — it returns a "Page Not Found" page — so the valid test used a locally served minimal PDF instead.) |
| A download | Works | App view: navigating to an attachment saves the file (probe.txt) into the profile's download folder, with no dialog blocking it. Note: the bare window's Playwright download event did not fire for the same file — Electron downloads bypass the Chromium download shelf that Playwright listens to, so that is a harness limit, not a product result. |
| A harmless local login form | Works | App view loads the form. Engine window: filling and submitting it delivers both fields to the local server, which answers "Login received". Field values were never logged. |
| A page asking for camera/microphone | Denied, with a clear message | App view: getUserMedia rejects with NotAllowedError — the standard, explicit denial. The page's own error path carries that message. No app-level toast was observed; the denial comes from the app's deny-by-default permission handlers. |

## ChatGPT (from the separate probe)

ChatGPT loads in the app's Default, brand-new, and temporary profiles
(~2 s, correct title, default settings: no proxy, no UA preset,
third-party cookies allowed). In the bare Electron window, an anonymous
message ("Hello") received a real assistant reply — the embedded
client is not refused. The user's logged-in "Unable to connect"
failure was not reproduced in any test arm (test profiles are
anonymous; the user's own logged-in profile was never touched), so it
is classified as a session/network problem, not an app bug and not a
site refusal of embedded browsers. Detail: the bare window's only
failed requests were 13 aborted analytics beacons
(net::ERR_ABORTED on chatgpt.com/unauth-mweb/events/*); there were no
console errors, no page errors, and no WebSocket use (the client uses
fetch). One early bare-window launch timed out at 180 s; the smoke
test and the rerun both launched it in under a second, so that was a
transient harness issue, not a product finding.
