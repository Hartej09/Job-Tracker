Job Tracker — Build Spec
Build a free, private, local-first Job Tracker in Python + SQL.

ENVIRONMENT
Windows 11, Python 3.11+ (tomllib needed). Work only in this project folder.
git init locally. Never create or push to a remote.
CONSTRAINTS
Zero cost. Allowed dependencies: streamlit, pandas, python-dotenv, pytest, google-api-python-client, google-auth-oauthlib, google-auth-httplib2, plyer. Ask me before adding anything not on this list.
Backend: SQLite via sqlite3 (plain SQL, no ORM). All SQL lives in db.py so it could be swapped for Postgres later; app.py and gmail_sync.py never write SQL.
On every connection: PRAGMA foreign_keys=ON, journal_mode=WAL, busy_timeout=5000 (the app and sync_cli.py may write at the same time).
Track schema version with PRAGMA user_version; migrations run automatically on start.
Dates stored as ISO-8601 text (YYYY-MM-DD for dates, UTC timestamps for *_at).
UI: Streamlit, local only. .gitignore: jobs.db*, credentials.json, token.json, .env, pycache/, .venv/.
Security: no secrets in code or git; config from .env; Gmail scope gmail.readonly only. Store only subject/sender/date/snippet, never full email bodies. Never log email content.
PHASE 1 — Tracker (build and test first)
Schema:
jobs(id, requisition_id, company, role, date_applied, status, location, salary_range, job_url, contact, email_domain, follow_up, notes, created_at, updated_at). Index on (company, requisition_id).
status_history(id, job_id FK, old_status, new_status, changed_at, source CHECK IN ('manual','email','import','inactivity')). Creating a job writes an initial row with old_status NULL.
suggestions(id, job_id FK, kind CHECK IN ('email','inactivity'), dedupe_key UNIQUE, gmail_message_id NULL, suggested_status, matched_by, subject, sender, email_date, snippet, state CHECK IN ('pending','accepted','dismissed'), created_at, resolved_at). dedupe_key is gmail:<message_id> for email suggestions and ghost:<job_id>:<last_activity_at> for inactivity suggestions. Email fields are NULL for inactivity suggestions.
sync_state(key PRIMARY KEY, value) for last_sync_at and history_id.
Statuses: Applied, Interviewing, Offer, Rejected, Ghosted, Withdrawn. Any transition is allowed. Enforce with a CHECK constraint.
UI:
"Add job" form. Required: requisition ID, company, role (all trimmed, non-empty). Warn (don't block) on duplicate company + requisition ID, case-insensitive.
Editable table (st.data_editor) with a status dropdown. Save by diffing edited rows against the DB and calling db functions; never overwrite blindly.
Filters: status multiselect and text search over company/role/requisition_id/notes.
Follow-up reminders: jobs whose follow_up date is today or earlier and whose status is not Rejected/Withdrawn/Offer.
Stats: count by status (bar chart via Streamlit built-ins), applications per week.
CSV import with a column-mapping step: read the uploaded file's headers, auto-suggest a match for each DB field (case-insensitive, ignoring spaces and punctuation), and let me correct each with a dropdown. Show a preview before committing. Rows missing requisition ID, company, or role are listed in an editable table so I can fill them in before importing; I can also choose to skip them. Skip and report duplicates. Accept common date formats. Imported jobs write status_history with source='import'.
CSV export of the current filtered view.
Every status change goes through one db function that updates jobs and inserts status_history in the same transaction.
Tests (pytest, temp DB per test): CRUD, required-field validation, duplicate detection, status change writes history atomically, CSV import (column auto-mapping, rows missing required fields, bad dates, duplicates), follow-up query, migrations on an empty DB.
PHASE 1 DONE WHEN: pytest passes; streamlit run app.py starts without errors; you've imported a sample CSV with non-matching headers and some missing requisition IDs into a scratch DB and shown me the result. Stop and report before starting Phase 2.

PHASE 2 — Gmail sync and Review (only after I confirm Phase 1)
Gmail API, OAuth desktop flow, gmail.readonly. README covers: creating the Google Cloud project, enabling the Gmail API, OAuth consent screen set to "In production" (so refresh tokens don't expire after 7 days), the "Google hasn't verified this app" warning and how to proceed for personal use, and downloading credentials.json. The first sign-in is done with python sync_cli.py --auth, never inside Streamlit.
Sync:
First run: fetch messages from the last 60 days, using a configurable Gmail query (default excludes promotions/social). After that, sync incrementally with historyId. If the history ID has expired (404), fall back to a query since last_sync_at.
Triggers: (a) once per app process on start, guarded with st.cache_resource so reruns don't re-sync, and skipped silently if token.json is missing; (b) "Sync now" button; (c) sync_cli.py for Windows Task Scheduler (README gives the exact schtasks command). No background threads in Streamlit.
Show "Last synced: <time>" and any sync error in the UI. The app must work fully with no Gmail setup.
Matching, in order; stop at the first rule that yields exactly one job: a. requisition_id appears as a whole word in subject/body (only IDs >= 5 chars). b. sender domain == job.email_domain, unless the domain is on the shared-ATS list in config (greenhouse.io, lever.co, myworkdayjobs.com, icims.com, smartrecruiters.com, ashbyhq.com, workable.com, linkedin.com, indeed.com, editable). c. company name (whole word, case-insensitive) in sender display name or subject. If a step matches more than one job, try narrowing to jobs not in a final status (Rejected/Withdrawn); if still ambiguous, ignore the email. Record which rule matched in suggestions.matched_by.
Classifier: regex rules in rules.toml (editable, loaded with tomllib). Each category has include and exclude patterns. Precedence when several match: offer > rejection
interview > confirmation. Confirmation creates no suggestion. Skip suggestions whose status equals the job's current status.

Ghosted (inactivity) suggestions:
last_activity_at = latest of the job's last status change and its latest matched email date.
If status is Applied and last_activity_at is older than 30 days, or status is Interviewing and older than 21 days, create a pending suggestion (kind='inactivity', suggested_status='Ghosted'). Both thresholds are configurable in rules.toml.
Runs on app start (even with no Gmail setup), after every sync, and in sync_cli.py.
Dedupe on ghost:<job_id>:<last_activity_at>: a dismissed ghost suggestion does not come back until the job has new activity and goes quiet again.
Never auto-change status. Accepting writes status_history with source='inactivity'.
Never auto-change status. Store one suggestion per matched email (dedupe_key gmail:<message_id>, so dismissed/accepted emails are never re-suggested).
Sidebar badge "Review (N)" with the pending count (email + inactivity).
Highlight jobs with a pending suggestion in the main table.
notify.py: plyer desktop notification when sync_cli.py creates new suggestions; wrapped in try/except, fails silently, no network.
"Review" tab: for each pending suggestion show company, role, requisition ID, current status, suggested status, and either the email subject/sender/date/snippet or, for inactivity suggestions, "No activity for N days". Buttons: Accept, Dismiss, and a status dropdown + "Accept as". Accepting goes through the same status-change function with source='email' or 'inactivity'.
Tests: classifier (including overlap cases like "unfortunately we need to reschedule your interview"), matcher (ATS domains, short IDs, ambiguous company), suggestion dedupe, history-ID fallback, ghost thresholds and dismiss-then-new-activity cycle. Mock the Gmail service; tests make no network calls.
DELIVERABLES
db.py, app.py, gmail_sync.py, classifier.py, notify.py, sync_cli.py, rules.toml, tests/, requirements.txt (pinned versions), .env.example, README with setup and one-command run (streamlit run app.py).

WORKING AGREEMENT
Before writing code, show me the file layout and the schema SQL for approval.
If anything in this spec is ambiguous, ask rather than guess.