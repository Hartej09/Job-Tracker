# Job Tracker (Google Apps Script)

A private job-application tracker that runs as a web app on Google's servers, over
HTTPS, from your own Google account. Data lives in a Google Sheet in your Drive. Use
it from your phone or computer anywhere; your PC doesn't need to be on.

Free. Nothing to install. Only you can open it.

## Files to copy into Apps Script

| File here | Name in the Apps Script editor | What it is |
| --- | --- | --- |
| `Code.gs` | `Code.gs` | Server code: sheets, validation, import |
| `Index.html` | `Index` | Page layout |
| `Stylesheet.html` | `Stylesheet` | Styles (light/dark) |
| `JavaScript.html` | `JavaScript` | Page behavior |

Everything else in this folder (`dev/`, `tests/`) is for testing on a PC and is **not**
copied into Apps Script.

## Setup (once, ~5 minutes, best on a computer)

1. **Create the sheet.** Go to <https://sheets.new> and name it `Job Tracker`.
2. **Open the script editor.** In the sheet: **Extensions → Apps Script**.
3. **Paste the code.**
   - Replace everything in `Code.gs` with the contents of `Code.gs` from this folder.
   - Click **+** next to *Files* → **HTML**, name it `Index` (no `.html`), and paste
     `Index.html` into it, replacing what's there. Do the same for `Stylesheet` and
     `JavaScript`.
   - Click **Save** (💾).
4. **Create the tabs and grant access.** In the toolbar's function dropdown pick
   **`setup`**, then **Run**. Google asks for permission:
   - Choose your account. You'll see **"Google hasn't verified this app"** — that's
     normal for your own scripts. Click **Advanced → Go to Job Tracker (unsafe)**.
   - The only permission requested is to view and edit **this one spreadsheet**
     (`@OnlyCurrentDoc` in `Code.gs` keeps it from touching your other files).
   - Back in the sheet you'll now have `Jobs` and `StatusHistory` tabs. You can delete
     the empty `Sheet1`.
5. **Publish it as a web app.** **Deploy → New deployment** → gear icon → **Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Only myself**
   - **Deploy**, then copy the **Web app URL** (it ends in `/exec`).
6. **Put it on your phone.** Open that URL in your phone's browser (signed in to the
   same Google account) and add it to the home screen:
   Safari → Share → **Add to Home Screen**, or Chrome → ⋮ → **Add to Home screen**.

## Updating the code later

Paste the new file contents, **Save**, then **Deploy → Manage deployments** → pencil
icon → *Version:* **New version** → **Deploy**. The URL stays the same.
(**Deploy → Test deployments** gives a `/dev` URL that always runs the latest saved
code — handy for trying changes before publishing them.)

## Using it

- **Jobs** — cards for each job, filter by status, search company/role/requisition
  ID/notes, **Export** the current view as CSV. **Update** a card to change status,
  follow-up date, notes or any other field; **History** shows every status change.
- **Add** — requisition ID, company and role are required. If you already have a job
  with the same company + requisition ID (ignoring case), you're warned first and can
  **Add anyway**.
- **Follow-ups** — jobs whose follow-up date is today or earlier and that aren't
  Rejected, Withdrawn or an Offer. The badge shows how many.
- **Stats** — jobs by status and applications per week (weeks start Monday).
- **Import** — upload a CSV (the tab has a *How to import* guide, the list of required
  and optional columns, and a blank template to download). Columns are matched automatically (ignoring case, spaces
  and punctuation, plus common names like "Req #", "Position", "Employer"); fix any
  match with the dropdowns. Rows with a missing requisition ID/company/role, a date it
  can't read or an unknown status are listed so you can fix them or tick **Skip**.
  Duplicates are skipped and listed. Dates are read **US-style**: `03/04/2026` is
  March 4. A blank status imports as Applied.

### Editing the sheet directly

The `Jobs` tab is a normal spreadsheet, so you can also edit there (handy for bulk
changes on a computer):

- Changing one **Status** cell at a time is recorded in `StatusHistory`, just like in
  the app. Pasting over several status cells at once is not recorded (you'll get a
  reminder).
- Dates typed in a common format (e.g. `3/4/2026`) are converted to `2026-03-04`.
- Don't edit `id`, `created_at` or `updated_at` (you'll get a warning if you try), and
  add new jobs in the app rather than as new sheet rows — rows without an `id` are
  ignored.

## How the data is stored

- `Jobs`: one row per job. `StatusHistory`: one row per status change with
  `source` = manual / import (email / inactivity come in Phase 2).
- All values are stored as plain text, so Sheets never reformats dates or treats text
  as a formula. Dates are `YYYY-MM-DD`; timestamps are UTC.
- Every status change goes through one function that writes the job and its history
  row together, and undoes the job change if the history write fails.
- Each save checks the job hasn't changed since you opened it (e.g. on another
  device); if it has, nothing is overwritten and the latest version is shown.
- Backups: in the sheet, **File → Download** (or **File → Make a copy**). Google also
  keeps version history (**File → Version history**).

## Troubleshooting

- **"Sorry, unable to open the file at this time"** — usually several Google accounts
  are signed in to the same browser. Open the URL in a private window, or make the
  tracker's account the first one you signed in with.
- **Changes don't show up after pasting new code** — you need a *new version* of the
  deployment (see *Updating the code later*).

## Testing on a PC (optional, for development)

Requires Node.js 20+. No packages to install.

```powershell
node --test                # unit tests for Code.gs against an in-memory sheet
node dev/serve.js          # preview the real UI at http://localhost:8765/?seed
```

The preview runs `Code.gs` in the browser against fake Sheets services
(`dev/gas-mocks.js`), seeded with sample jobs; `dev/sample_jobs.csv` is a messy CSV
for trying the import.
