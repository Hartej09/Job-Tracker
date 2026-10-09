# Job Tracker

A free, private, local-first job application tracker. Python + SQLite + Streamlit.
Everything stays on your machine in a single SQLite file.

## Setup (once)

Requires Python 3.11+ on Windows. From this folder:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env   # optional: change JOBTRACKER_DB_PATH
```

## Run

Double-click **`run_desktop.cmd`**, or from PowerShell in this folder:

```powershell
.\.venv\Scripts\streamlit.exe run app.py
```

It opens at http://localhost:8501 and only this PC can connect
(see `.streamlit/config.toml`). The database (`jobs.db` by default) is created and
migrated automatically on start. Close the window (or Ctrl+C) to stop.

## Use it on your phone (same network)

The app and data stay on your PC; the phone opens it in its browser over whatever
network both are connected to — home Wi-Fi, office or café Wi-Fi, or the PC's own
Windows **Mobile hotspot** (Settings → Network & internet → Mobile hotspot). The PC
must be on and awake.

One-time setup:

1. **Allow the app through the firewall for devices on the same network.** In
   PowerShell *run as administrator*:

   ```powershell
   New-NetFirewallRule -DisplayName "Job Tracker (same network)" -Direction Inbound -Protocol TCP -LocalPort 8501 -Profile Any -RemoteAddress LocalSubnet -Action Allow
   ```

   This allows only port 8501, and only from devices on the same local network as
   the PC, on any network type (home, public or work).
2. **Set a password (strongly recommended).** Copy `.env.example` to `.env` and set
   `JOBTRACKER_PASSWORD=...`. "Same network" includes everyone else on that network —
   on café or office Wi-Fi that means strangers.

Each time: double-click **`run_phone.cmd`**, then open the **Network URL** it prints
(e.g. `http://192.168.0.111:8501`) on your phone. Phones open the **Phone view** page
automatically. To get an app icon: Safari → Share → *Add to Home Screen*, or
Chrome → ⋮ → *Add to Home screen*. The address changes between networks (and
sometimes on the same network), so use the Network URL printed that day.

Good to know:

- Many public and office Wi-Fi networks block devices from talking to each other
  ("client isolation"). If the phone can't connect there, turn on the PC's Mobile
  hotspot and connect the phone to that — it works anywhere.
- The connection is plain HTTP, so on open public Wi-Fi others on the network could
  in principle see the traffic (including the password). On untrusted Wi-Fi, prefer
  the PC's hotspot.

To turn phone access off, just use `run_desktop.cmd`. To remove the firewall rule:
`Remove-NetFirewallRule -DisplayName "Job Tracker (same network)"` (as administrator).

## Features (Phase 1)

- **Phone view**: one card per job, follow-ups due at the top, status filter and
  search, and an *Update* form per job (status, follow-up date, notes).
- **Jobs**: editable table with a status dropdown, filters (status + text search over
  company/role/requisition ID/notes), delete with confirmation, per-job status history,
  and CSV export of the current filtered view.
  Edits are saved by diffing against the database; if a row changed elsewhere since
  you loaded it, that row is skipped and reported instead of being overwritten.
- **Add job**: requisition ID, company and role are required. A duplicate company +
  requisition ID (case-insensitive) shows a warning with an "Add anyway" option.
- **Follow-ups**: jobs whose follow-up date is today or earlier and whose status is
  not Rejected, Withdrawn or Offer. The sidebar shows the count.
- **Stats**: jobs by status and applications per week (weeks start Monday).
- **Import CSV**:
  1. Upload a file; each field is auto-matched to a column (ignoring case, spaces and
     punctuation, plus common aliases such as "Req #", "Position", "Employer").
     Correct any match with the dropdowns.
  2. Rows missing requisition ID/company/role, with unrecognized dates, or with
     unknown statuses appear in an editable table — fix them or tick **Skip**.
  3. Preview, then import. Duplicates (already in the tracker, or repeated in the file)
     are skipped and listed.

  Dates use **US order**: `03/04/2026` is March 4. Also accepted: `2026-03-04`,
  `3/4/26`, `Mar 4 2026`, `March 4, 2026`, `4 Mar 2026`, `04-Mar-2026`, and
  timestamps like `2026-03-04T10:15:00Z`. A blank status imports as Applied.

## Data

- SQLite with WAL mode; all SQL is in `db.py`.
- Every status change goes through `db.change_status()`, which updates the job and
  writes `status_history` in one transaction (`source` = manual/email/import/inactivity).
- Schema version is tracked with `PRAGMA user_version`; migrations run on start.
- Dates are stored as `YYYY-MM-DD`; timestamps as UTC ISO-8601.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest
```

Each test uses its own temporary database.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | Streamlit UI (no SQL) |
| `db.py` | Schema, migrations and all queries |
| `csv_import.py` | CSV header mapping, date/status parsing, row validation |
| `samples/messy_jobs.csv` | Example CSV with non-matching headers and problem rows |
| `run_desktop.cmd` / `run_phone.cmd` | Start the app for this PC only / for phones on the same Wi-Fi |
| `.streamlit/config.toml` | Localhost-only by default; usage statistics off |
| `tests/` | pytest suite |
