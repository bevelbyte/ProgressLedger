# Unknown scheduled tasks — read-only investigation (2026-10-27)

Nothing here was run, disabled, or deleted. Every fact below comes from
the task's own registration (schtasks /Query /XML and /V), its task
file timestamp, and reading the file its action points at. The exact
disable and delete commands are given for the user to run himself.

## 1. \RunDonutTest — LOW risk, and already spent

- Created: 2026-10-25 03:06:15 by TUF-A15\Asus (registration date and
  task-file time agree).
- Runs as: Asus (SID ending 1001), interactive logon token.
- Highest privileges: NO. No RunLevel is set, so it runs at standard
  rights.
- Trigger and next run: a single one-time trigger, 2026-10-25 23:59.
  Next run time is N/A — that time has passed, so it will never fire
  again on its own.
- Last run: 2026-10-25 23:59, result 0 (success).
- Exact command: `cmd.exe /c "D:\Muse_Workspace\projects\browser_lab\Donutbrowser-fork\__ [ LAUNCH DONUT BROWSER PRO] __.bat"`
- The file exists (1,280 bytes, 2026-10-25 02:32). What it does, read
  not run: it changes into its own folder, requires
  `_tools\browser-state.txt` to report 5 patches (otherwise it stops
  with BLOCKED), runs the browser binary's `--verify-build` seal
  check (otherwise it stops with BLOCKED), then launches Donut
  Browser Pro in shared-profiles mode
  (`_tools\DonutBrowser-Unlocked.exe`, falling back to
  `_tools\DonutBrowser-Dev.exe`) with
  `DONUTBROWSER_DATA_DIR=C:\Users\Asus\AppData\Local\DonutBrowser`.
- Touches this project: NO. It touches only the browser_lab Donut
  fork and Donut's own data folder. Progress Ledger v2 is untouched.
- Risk: LOW. Standard rights, one-time trigger already spent, and it
  is the user's own browser project. It is harmless to leave, and
  safe to delete because it can never run again.
- Disable: `schtasks /Change /TN \RunDonutTest /Disable`
- Delete: `schtasks /Delete /TN \RunDonutTest /F`

## 2. \cua-driver-serve — MEDIUM risk, currently broken

- Created: task file 2026-08-22 22:06. No author is recorded in the
  registration (Author field empty); it runs as the user's account
  (SID ending 1001).
- Runs as: Asus, interactive logon token.
- Highest privileges: YES. RunLevel is HighestAvailable, and its own
  description says so: "RunLevel=Highest for UWP/AppContainer
  support".
- Trigger and next run: at the user's logon, every logon. Next run
  time shows N/A (logon triggers do not pre-schedule a time).
- Last run: 2026-10-21 23:07, result 0. No execution time limit, and
  it restarts up to 3 times on failure.
- Exact command: `powershell.exe -NoProfile -WindowStyle Hidden
  -NonInteractive -Command "Start-Process -FilePath
  'C:\Users\Asus\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe'
  -ArgumentList 'serve' -WindowStyle Hidden -WorkingDirectory
  'C:\Users\Asus'"`
- The file does NOT exist: `cua-driver.exe` is missing from that
  path (checked 2026-10-27). So at the next logon the task will try
  to start a daemon that is not there and fail. Its purpose, from its
  own description, is a "cua-driver: serve daemon, auto-start at
  interactive logon" — a local automation-driver server, run hidden.
- Touches this project: NO. Cua is separate automation tooling;
  Progress Ledger v2 is untouched.
- Risk: MEDIUM. Elevated, hidden, every logon, unlimited runtime,
  auto-restart — that is the strongest persistence shape of the
  three. It is inert right now only because its target file is
  gone. If Cua is reinstalled, the elevated hidden daemon resumes.
  Confirm it is still wanted before keeping it; disable it until
  then if Cua is abandoned.
- Disable: `schtasks /Change /TN \cua-driver-serve /Disable`
- Delete: `schtasks /Delete /TN \cua-driver-serve /F`

## 3. \CoolControl — LOW-MEDIUM risk

- Created: task file 2026-09-20 18:08. Author recorded as
  "CoolControl" (the application's own installer, not a person).
- Runs as: Asus (SID ending 1001), interactive logon token.
- Highest privileges: YES. RunLevel is HighestAvailable.
- Trigger and next run: at logon (no specific user named, so any
  logon). Next run time shows N/A.
- Last run: 2026-10-24 01:25, result 267014 (0x41306 — the
  scheduler's code for a terminated last run, typically logoff,
  shutdown, or a manual stop; not a crash code).
- Exact command: `"D:\1_Education\AsusPowerFlow\coolcontrol\bin\Release\net8.0-windows\CoolControl.exe"`
- The file exists (179,712 bytes, 2026-10-24 01:25 — the same minute
  as its last run, consistent with a fresh dev build). It is the
  user's own AsusPowerFlow laptop cooling/fan-control utility
  (.NET 8 Windows app). No window-hiding flags are set, so it runs
  as a normal app.
- Touches this project: NO. AsusPowerFlow is a separate project;
  Progress Ledger v2 is untouched.
- Risk: LOW-MEDIUM. Elevated and persistent at logon, but it is the
  user's own utility with a clear purpose, and its last run ended
  normally (terminated, not failed). Keep it if the fan control is
  still used; otherwise delete it.
- Disable: `schtasks /Change /TN \CoolControl /Disable`
- Delete: `schtasks /Delete /TN \CoolControl /F`

## 4. \V2GFinalGate — NONE (deleted, verified absent)

- Created: 2026-10-26 07:15:28 by TUF-A15\Asus (from the deletion
  record of 2026-10-26).
- Ran as: Asus, standard rights (no RunLevel — Limited).
- Trigger: a single one-time trigger, 2026-10-26 23:59. Last ran
  2026-10-26 07:15:29, result 0.
- Exact command (when it existed): `cmd /c start /min /low
  D:\Muse_Workspace\tasks\2026-10-24_progress_ledger_v2\work\v2-d4-gate.cmd`
  — a Progress Ledger v2 Phase 4 gate script. This is the one task
  of the four that did touch this project, and it was a
  user-authorized, one-shot job.
- Status now: DELETED on 2026-10-26 by user authorization, and
  verified absent again on 2026-10-27 (schtasks /Query returns
  "The system cannot find the file specified").
- Risk: NONE. There is nothing to disable or delete; the commands
  below would only return "file not found".
- Disable (not applicable): `schtasks /Change /TN \V2GFinalGate /Disable`
- Delete (not applicable): `schtasks /Delete /TN \V2GFinalGate /F`
