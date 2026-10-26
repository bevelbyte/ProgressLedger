# Progress Ledger v2 — deferred ideas (NOT built)

These ideas were considered and deliberately left out of the current
build. Each note states the main risk, so a future decision can weigh
it instead of rediscovering it. Nothing here is a promise to build it.

## Cookie import/export

Risk: cookies are live session credentials. An exported cookie file is
a login: anyone who gets it can open your logged-in accounts without a
password, and a file sitting on disk (or sent anywhere) keeps working
until the session expires. Import is the mirror risk: cookies from
another browser or machine merge untrusted sessions into this profile,
including tracking cookies and possibly a planted session. Profile
data on disk is not encrypted, so export would widen the exposure
instead of containing it.

## Profile transfer (moving a browser profile to another workspace or machine)

Risk: a transferred profile carries its cookies, storage, cache, and
login state together, so it carries the same session-hijack risk as
cookie export, plus fingerprint state (storage, cache, settings) that
can link the two machines. The destination also cannot verify where
the profile came from, so a tampered profile would be trusted as your
own.

## Per-profile logs (request/network logs)

Risk: a request log captures URLs, headers, and sometimes POST bodies
and tokens. That file is both a browsing-history leak and a credential
leak, and it keeps growing unless retention is designed first. Who can
read it, where it is stored, and when it is deleted need answers before
logging starts, not after.

## Request viewer (inspecting live requests for a page)

Risk: a viewer shows headers, cookies, and bodies to anyone looking at
the screen (including screenshots and screen sharing), and a copy
button would let session tokens leave the app in one click. Building
one also tempts adding request interception to the browser, which
would weaken the current fail-closed posture (pages are governed by
deny-by-default handlers, not by a live inspector).

## Password protection of profile data

Risk: the hard part is the key, not the lock. If the key is derived
from a password, forgetting the password means total, unrecoverable
data loss; if the key is stored on disk next to the data, the
protection is theatre. Partial encryption (some files locked, others
not) is worse than none because it looks safe while the session files
that matter stay readable. The partition directory is owned by
Chromium while the app runs, so real at-rest protection needs
operating-system support (for example Windows DPAPI for the key) and
still leaves the data open while the app is running.

## Also not built (by decision, not by deferral)

Fingerprint settings, sync, a launch hook, 2FA codes, extensions, VPN
or DNS controls, and a debugging endpoint are not in this build and
are not queued here: fingerprint spoofing and evasion are out of
scope, and a debugging endpoint would expose the app's internals to
any local process.
