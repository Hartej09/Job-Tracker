# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner, a job seeker tracking their own applications. Access is "Only myself" (Google account). Used mostly on a phone for quick checks between other things (installed to the home screen), and at a desk for editing and bulk work. Multi-user is not a goal.

## Product Purpose

A private job-application tracker that runs as a Google Apps Script web app over HTTPS, with data in a Google Sheet in the user's own Drive. It works from anywhere without a PC running. Success: at a glance, the user knows what needs attention next and never loses an edit.

## Positioning

It reads Gmail (read-only) and inactivity, then **suggests** status changes ("looks like a rejection", "gone quiet") that the user accepts or dismisses. It never changes a status by itself. Free, nothing to install, private, and the data stays in the user's own account.

## Operating Context

Deployed from copy-pasted files in the Apps Script editor (no clasp, no third-party installs). Hourly Gmail sync via a time trigger. Local preview and tests run on Node (`dev/serve.js`, `tests/`). Jobs are imported from CSV; requisition IDs are first-class.

## Capabilities and Constraints

- Statuses: Applied, Interviewing, Offer, Rejected, Ghosted, Withdrawn.
- Pages: Jobs, Follow-ups, Review (suggestions), Stats; details panel (desktop) or bottom sheet (phone).
- Permissions fixed in `appsscript.json`: read Gmail, edit one spreadsheet, run on a schedule.
- Spec.md describes the earlier Python design; its data model, statuses, CSV rules and matching rules still apply conceptually.
- Scope stated by the user is not narrowed silently; offer safer options instead.

## Brand Commitments

None beyond the existing name "Job Tracker". Existing visual decisions are recorded in DESIGN.md.

## Evidence on Hand

`dev/sample_jobs.csv` and the `?seed` preview data are sample data only. No real testimonials, users or metrics exist; don't invent any.

## Product Principles

- Answer "what needs attention next" before anything else.
- Suggest, never act: the person decides every status change.
- Never lose the user's edits.
- Same functions at every screen size.
- Stay private, free and self-contained in the user's own Google account.

## Accessibility & Inclusion

Text at least 4.5:1 contrast in light and dark; control edges 3:1; 44px minimum touch targets on phones; status never conveyed by colour alone; iOS text-size scaling respected; `prefers-reduced-motion` honoured.
