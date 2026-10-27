# Running the app, and using the Page network log

## Run (development)

From the repo root:

```
npm run dev
```

That starts the UI watcher and the Electron shell. The app opens with the
development data directory, never the installed app's live data.

## Page network log (Settings > Diagnostics) — Bug 3 diagnostic

Use this when a browser page loads but something inside it fails — for
example, ChatGPT loads in a brand-new profile but sending a message shows
"Unable to connect". The log records, for the current browser page only,
the failed requests: host, path (no query string), HTTP status or
Chromium error code, and time. It is memory only: nothing is written to
disk, nothing is sent anywhere, and it is cleared when the page closes
or when you turn it off. It is OFF until you turn it on.

Exact steps:

1. Open the browser page first (for the ChatGPT case: a brand-new
   profile, chatgpt.com loaded).
2. Go to Settings > Diagnostics.
3. In the "Page network log" section, turn the log ON.
4. Go back to the browser page and do the failing action (for the
   ChatGPT case: send "hello").
5. Go back to Settings > Diagnostics and press Refresh in the "Page
   network log" section.
6. Read the entries. Each row shows when it failed, the host and path,
   and the HTTP status (for example `HTTP 503`) or the Chromium error
   (for example `net::ERR_CONNECTION_REFUSED`). A query string never
   appears: the path is shown without it.
7. The same section shows two plain facts, recorded verbatim and never
   changed: the page's user agent as the page sees it, and whether the
   session user agent contains "Electron" (Yes or No).
8. When you are done, turn the log OFF. Turning it off clears the
   recorded entries at once.

What the log deliberately does NOT record: successful requests, query
strings, fragments, headers, cookies, or request/response bodies. A
navigation abort (`net::ERR_ABORTED`, for example from navigating away)
is not recorded either — it is a superseded navigation, not a failure.
If the log is empty after a failing action, that itself is evidence:
either the failure produced no failed request the app can see, or the
page was not the current browser page when the action happened (open
the page in the browser pane first, then turn the log on).
