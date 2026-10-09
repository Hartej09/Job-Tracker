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

```powershell
.\.venv\Scripts\activate
streamlit run app.py
```

The database (`jobs.db` by default) is created and migrated automatically on start.

## Features (Phase 1)

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
| `tests/` | pytest suite |
