# Progress Ledger v2 — how to run it

## Start it

Double-click **Progress Ledger v2** on the Desktop
(`C:\Users\Asus\Desktop\Progress Ledger v2.bat`).

The launcher starts the packaged build
(`release\win-unpacked\Progress Ledger v2.exe`) as your normal
user, with no elevation and no test settings. If the packaged
build is missing, the launcher builds it first
(`npm run dist:dir`, which runs the full build including the
UI); a normal double-click after that starts instantly and
builds nothing. Note: the packaged build freezes the UI at
packaging time, so after UI source changes, run
`npm run dist:dir` again before relying on the new UI.

Do not run the app from a test command that sets
`PROGRESSLEDGER_V2_E2E` or `PROGRESSLEDGER_V2_E2E_USER_DATA`.
Those flags change behaviour (they bypass the first-run
workspace setup, force a workspace, and skip the
single-instance lock) and point the app at a different data
folder. They are for automated tests only.

## Where the data is

Your real data lives in your own folder, separate from any
test run:

- Data folder: `%APPDATA%\progress-ledger-v2`
  (for example `C:\Users\Asus\AppData\Roaming\progress-ledger-v2`)
- Database inside it: `progress-ledger-v2.db`
- Crash logs inside it: `crash-logs\`

Test runs use a different, throwaway folder and never touch
this one. The original Progress Ledger app's data folder is
different again (no `-v2` suffix); this build never opens it.

## How to reset it

Warning: this deletes all local Progress Ledger v2 data.

1. Quit Progress Ledger v2 completely (close the window; if a
   second launch exits at once, the first instance is still
   running — close that one).
2. Rename the data folder above (safer) or delete it.
3. Start the app again. It creates a fresh data folder and
   runs first-run setup.

## Removing a test-created workspace (for example "Proof 1792878075719")

Some workspace profiles in your real data were created by automated test
runs, not by you — for example "Browser Phase Two" and
"Proof 1792878075719". Test runs can no longer do this: since this
change, test mode refuses to start when its data folder is the real
one (see the guard in shell/src/main.js). Nothing below deletes or
resets your real data — it removes one workspace only, and only when
you choose to.

To remove one workspace, in the app:

1. Open the app and go to Profiles (Runs → Profiles).
2. Find the workspace card (for example "Proof 1792878075719").
3. Open the card's menu and choose Delete, then confirm the deletion
   in the dialog. The workspace and its own data are removed; your
   other workspaces are untouched.
4. Check the Profiles list: the card is gone, and the status bar shows
   one of your remaining workspaces.

Do not delete the workspace by hand-editing the database file
(progress-ledger-v2.db) or by deleting files inside the data folder:
hand edits can corrupt the database, and deleting the whole folder
removes everything (see "How to reset it" above). If the in-app
delete fails, keep the workspace and report the exact error instead
of deleting files by hand.

The same steps remove "Browser Phase Two" if you want it gone too.

## If the window does not appear

1. Look in the taskbar first. The app allows only one
   instance: launching it a second time exits at once and
   leaves the first window where it was. Bring that window
   forward instead of launching again.
2. Do not run it as administrator to "fix" this. Elevation
   changes which data folder and profile Windows uses.
3. If it crashed, look in
   `%APPDATA%\progress-ledger-v2\crash-logs\` for a
   timestamped log and keep it for diagnosis.
4. If the window opens off-screen, close the app, start it
   again, and check the taskbar. Do not delete the data
   folder for a window-position problem.
5. If it still does not start, run the Desktop launcher from
   a command prompt once and read the error it prints, then
   report that exact text.
