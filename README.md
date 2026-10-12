# Job Tracker (Google Apps Script)

A private job-application tracker that runs as a web app on Google's servers, over
HTTPS, from your own Google account. Data lives in a Google Sheet in your Drive. Use
it from your phone or computer anywhere; your PC doesn't need to be on.

It can also read your Gmail (read-only) and **suggest** status changes — "this looks
like a rejection", "this job has gone quiet" — which you accept or dismiss. It never
changes a status by itself.

Free. Nothing to install. Only you can open it.

## Files to copy into Apps Script

| File here | Name in the Apps Script editor | What it is |
| --- | --- | --- |
| `appsscript.json` | `appsscript.json` | Permissions and settings (see setup step 3) |
| `Code.gs` | `Code.gs` | Jobs, history, validation, CSV import |
| `Sync.gs` | `Sync.gs` | Gmail sync, matching, suggestions |
| `Index.html` | `Index` | Page layout |
| `Stylesheet.html` | `Stylesheet` | Styles (light/dark) |
| `JavaScript.html` | `JavaScript` | Page behavior |

Everything else in this folder (`dev/`, `tests/`) is for testing on a PC and is **not**
copied into Apps Script.

## Setup (once, ~10 minutes, best on a computer)

1. **Create the sheet.** Go to <https://sheets.new> and name it `Job Tracker`.
2. **Open the script editor.** In the sheet: **Extensions → Apps Script**.
3. **Show the manifest.** Click the gear (**Project Settings**) and tick **Show
   "appsscript.json" manifest file in editor**. Back in the editor (**<>**), open
   `appsscript.json` and replace its contents with this folder's `appsscript.json` —
   **but keep your own `"timeZone"` line** (the value that was already there).
4. **Paste the code.**
   - Replace everything in `Code.gs` with this folder's `Code.gs`.
   - **+** next to *Files* → **Script**, name it `Sync`, paste `Sync.gs`.
   - **+** → **HTML**, name it `Index` (no `.html`), paste `Index.html`. Same for
     `Stylesheet` and `JavaScript`.
   - **Save** (💾).
5. **Run setup.** In the toolbar's function dropdown pick **`setup`**, then **Run**.
   - Google asks for permission. You'll see **"Google hasn't verified this app"** —
     normal for your own scripts: **Advanced → Go to Job Tracker (unsafe)**.
   - It asks for exactly three things (fixed in `appsscript.json`):
     **read your Gmail** (read-only — it can't send, delete or change anything),
     **edit this one spreadsheet**, and **run on a schedule** (the hourly sync).
   - `setup` creates the tabs (`Jobs`, `StatusHistory`, `Suggestions`, `Settings`,
     `Rules`), turns on the hourly sync and checks the last 60 days of email. That can
     take a few minutes; the log at the bottom says when it's done. If there's a lot
     of mail, the rest is picked up by the next syncs automatically.
   - You can delete the empty `Sheet1`.
6. **Publish it as a web app.** **Deploy → New deployment** → gear icon → **Web app**:
   *Execute as:* **Me**, *Who has access:* **Only myself** → **Deploy**, and copy the
   **Web app URL** (it ends in `/exec`).
7. **Put it on your phone.** Open that URL on your phone (signed in to the same Google
   account) → Safari → Share → **Add to Home Screen**, or Chrome → ⋮ → **Add to Home
   screen**.

### Upgrading from the Phase 1 version

Do steps 3–5 above (manifest, paste `Code.gs`/`JavaScript`/`Stylesheet`/`Index`, add
`Sync`, run `setup` and approve the new Gmail permission), then **Deploy → Manage
deployments** → pencil → *Version:* **New version** → **Deploy**. Your jobs and
history are kept; the `Jobs` tab gets one new column, `last_email_at`.

## Updating the code later

The candidate portal link added a column: the `Jobs` tab gets `portal_url` right after
`last_email_at`, added automatically the first time the updated app opens. Paste the new
`Code.gs`, `Sync.gs` and the three HTML files, then **Deploy → Manage deployments →
New version**.

Paste the new file contents, **Save**, then **Deploy → Manage deployments** → pencil
icon → *Version:* **New version** → **Deploy**. The URL stays the same.
(**Deploy → Test deployments** gives a `/dev` URL that always runs the latest saved
code — handy for trying changes before publishing them.)

## Using it

- **Jobs** — cards for each job, filter by status, search company/role/requisition
  ID/notes. **Update** a card to change status, follow-up date, notes or any other
  field; **History** shows every status change. A blue edge and a *Suggested: …* tag
  mean a suggestion is waiting in Review. **Import** and **Export** (CSV) are at the top.
- **Add** — requisition ID, company and role are required. If you already have a job
  with the same company + requisition ID (ignoring case), you're warned first and can
  **Add anyway**.
- **Follow-ups** — jobs whose follow-up date is today or earlier and that aren't
  Rejected, Withdrawn or an Offer. The badge shows how many.
- **Review** — suggested status changes, with the badge showing how many are waiting.
  Each shows the job, its current → suggested status, and either the email (subject,
  sender, date, snippet, and what it was matched by) or "No activity for N days".
  **Accept**, **Dismiss**, or pick a different status and **Accept as**. Also shows when
  Gmail was last synced, any sync problem, and a **Sync now** button.
- **Stats** — jobs by status and applications per week (weeks start Monday).
- **Import** (from Jobs) — upload a CSV. The page has a *How to import* guide, the
  required and optional columns, and a blank template. Columns are matched
  automatically; fix any match with the dropdowns. Rows with a missing requisition
  ID/company/role, an unreadable date or an unknown status are listed to fix or
  **Skip**. Duplicates are skipped. Dates are **US-style**: `03/04/2026` is March 4.

## Gmail suggestions — how they work

**When it syncs:** every hour in the background (even with your phone and PC off),
when you open the app if the last sync was over 15 minutes ago, and when you tap
**Sync now**. The first sync looks back 60 days; after that only new mail is checked.

**Which job an email belongs to** — tried in this order, stopping at the first that
finds exactly one job:

1. the job's **requisition ID** appears as a whole word in the subject or body (IDs of
   5+ characters only);
2. the sender's **email domain** equals the job's *Email domain* field (never for shared
   recruiting systems like greenhouse.io or lever.co — see `ats_domains`);
3. the **company name** appears as a whole word in the sender's name or the subject.

If a step matches several jobs, it keeps only the ones not Rejected/Withdrawn; if it's
still more than one, the email is ignored rather than guessed. Tip: fill in *Email
domain* (e.g. `acme.com`) on jobs where you deal with a company's own recruiters.

**What it suggests:** the email is checked against the patterns in the `Rules` tab:
**offer** → Offer, **rejection** → Rejected, **interview** → Interviewing,
**confirmation** → nothing. When several match, the first in that order wins (so
"we'd like to extend an offer" beats everything; "unfortunately we need to reschedule
your interview" is an interview because the rejection rule excludes "reschedul").
No suggestion is made if the job already has that status. Each email is suggested at
most once — dismissed emails never come back.

**Ghosted:** an Applied job with no activity for **30 days**, or an Interviewing job
for **21 days**, gets a *Ghosted* suggestion. Activity = its last status change or its
latest matched email (even a confirmation). If you dismiss it, it only comes back after
new activity and another quiet spell.

**Privacy:** Gmail access is read-only. Only the subject, sender, date and a short
snippet of emails that become suggestions are saved (in the `Suggestions` tab). Email
bodies are read in memory to find IDs and keywords, and are never saved or logged.

### Settings and Rules tabs

Edit these in the sheet — no code changes or redeploy needed.

- **Settings**: `gmail_query` (which emails to check, in Gmail search syntax — default
  skips Promotions, Social and your sent mail), `initial_sync_days`, `auto_sync_hours`
  (1, 2, 4, 6, 8 or 12; 0 = off), `ghost_applied_days`, `ghost_interviewing_days`,
  `ats_domains`, `min_requisition_id_length`.
- **Rules**: one row per pattern — `category` (offer / rejection / interview /
  confirmation), `type` (include / exclude) and `pattern` (a regular expression,
  case-insensitive). A category applies when any *include* matches and no *exclude*
  does. A broken row is reported on the Review tab.

### Editing the sheet directly

The `Jobs` tab is a normal spreadsheet, so you can also edit there:

- Changing one **Status** cell at a time is recorded in `StatusHistory`, just like in
  the app. Pasting over several status cells at once is not recorded (you'll get a
  reminder).
- Dates typed in a common format (e.g. `3/4/2026`) are converted to `2026-03-04`.
- Don't edit `id`, `created_at`, `updated_at` or `last_email_at` (you'll get a warning),
  and add new jobs in the app rather than as new sheet rows — rows without an `id` are
  ignored. Your own extra columns to the right of `portal_url` are fine.

## How the data is stored

- `Jobs`: one row per job. `StatusHistory`: one row per status change, with `source` =
  manual / import / email / inactivity. `Suggestions`: one row per suggestion
  (`pending`, `accepted` or `dismissed`).
- All values are stored as plain text, so Sheets never reformats dates or treats text
  as a formula. Dates are `YYYY-MM-DD`; timestamps are UTC.
- Every status change — typed, imported or accepted from a suggestion — goes through
  one function that writes the job and its history row together.
- Each save checks the job hasn't changed since you opened it (e.g. on another device);
  if it has, nothing is overwritten and the latest version is shown.
- Backups: **File → Download** or **File → Make a copy**; Google also keeps **File →
  Version history**.

## Troubleshooting

- **"Sorry, unable to open the file at this time"** — usually several Google accounts
  are signed in to the same browser. Open the URL in a private window, or make the
  tracker's account the first one you signed in with.
- **Changes don't show up after pasting new code** — deploy a *new version* (see
  *Updating the code later*).
- **Review says "Gmail sync isn't set up"** — `appsscript.json` wasn't replaced (step 3).
- **Review shows a sync problem mentioning permission/authorization** — run `setup`
  once more from the editor and approve the permissions.
- **Background sync isn't running** — in the editor, **Triggers** (alarm-clock icon)
  should list `scheduledSync`. Running `setup` (or tapping **Sync now**) re-creates it.

## Testing on a PC (optional, for development)

Requires Node.js 20+. No packages to install.

```powershell
node --test                # tests for Code.gs and Sync.gs against in-memory Sheets/Gmail
node dev/serve.js          # preview the real UI at http://localhost:8765/?seed
```

The preview runs the `.gs` files in the browser against fake Sheets and Gmail services
(`dev/gas-mocks.js`), seeded with sample jobs and a small sample mailbox;
`dev/sample_jobs.csv` is a messy CSV for trying the import. No network calls.
