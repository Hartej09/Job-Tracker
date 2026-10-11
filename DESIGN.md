# Design notes

Decisions behind the Job Tracker UI, so later changes stay consistent. The look lives in
`Stylesheet.html`; behaviour in `JavaScript.html`; the page skeleton in `Index.html`.

## What the app is for

One job: show what needs attention next. Everything else (tables, forms, stats) supports that.
The signature element is the suggestion: Gmail or inactivity proposes a status change and the
person accepts or dismisses it. Suggestions surface as one "needs attention" strip on Jobs (suggestions and follow-ups side by side on wide screens, counts only), an Accept / Dismiss pair under the
status in the table and on phone cards (with the email subject shown, and a quieter outlined Accept for Rejected, Ghosted and Withdrawn), and the Suggestions page. Accepting or dismissing shows an Undo toast that puts the suggestion back; it is cleared when you change page. A job's pending suggestion also appears at the top of its drawer and phone sheet, so the reason for the flag is never hidden. Jobs with a suggestion or an
overdue follow-up sort first; no row is pre-opened.

## Look

- **Sky** theme: light blue-grey page, white surfaces, one blue accent. Follows the system light/dark
  setting; there is no in-app appearance switch.
- **Type**: Instrument Sans for everything, IBM Plex Mono for requisition IDs (so IDs read as IDs).
  Sizes are in `rem` and the root follows the iOS text-size setting. Inputs never go below 16px.
- **Status colours** are fixed meanings: Applied slate, Interviewing magenta, Offer green, Rejected red,
  Ghosted warm grey, Withdrawn amber. Every status also has a text label and a dot, never colour alone. Offer is the one solid pill (white on green), because it is the outcome worth noticing. Names and notes align to their own script, so Arabic and Hebrew sit right.
- **A proposal is a soft box.** A suggestion sits in a borderless fill (the page colour, like a secondary row in an inset list) with a small mail or clock symbol. No dashed borders. Its buttons follow Apple's ladder: tinted Accept for good news, gray Accept for Rejected, Ghosted and Withdrawn, plain Dismiss. Solid blue is kept for real commits (Save, Add job). The Suggestions page uses the same tinted / gray Accept.
- **Blue means "act"**: links, primary buttons, selection. Don't use it for status.

## Tokens (CSS variables in `:root`)

| Token | Use | Rule |
| --- | --- | --- |
| `--text`, `--text2`, `--muted`, `--faint` | text | every text token is at least 4.5:1 on the page and on white, in both appearances |
| `--accent` | link and selected-state text | brighter in dark mode (6.5:1 on cards) |
| `--accent-fill` | buttons, bars | deeper in dark mode so white text is 4.6:1 |
| `--control` | borders of inputs, chips, buttons | 3:1 against the surface |
| `--border`, `--border2` | decorative lines | not for control edges |

## Layout

- One breakpoint, 900px. Below it: bottom tab bar (Jobs, Follow-ups, Suggestions, Stats), "+" Add job in the
  Jobs header, cards that open a bottom sheet. At 900px and up: sidebar, job table, details panel.
- Layout follows the space available, not the device. Same functions at every size.
- On wide screens the details panel is a drawer over the right edge (Escape closes it), so the table keeps every column.

## Behaviour rules

- **Limits.** Text fields cap at 200 characters (URL 2,000, notes 5,000); the error names the field and the limit.
- **Save waits for an edit.** Save stays disabled until a field changes.
- **Never lose edits.** A form with unsaved changes is not redrawn by refresh or sync, and closing it,
  switching rows, or changing page asks "Discard your changes?" first.
- **Errors stay until dismissed**; confirmations fade after 3.5s.
- **Targets**: 44px minimum on phones; the desktop minimum is 28px.
- **Empty states** always say what to do next and offer the button.
- **Long content wraps or clamps** (two lines in rows, three on cards) and shows in full in the panel or sheet.
- **Shortcuts**: `/` focuses search, `n` starts a new job (wide screens).

## Motion

Short and ease-out, nothing over 300ms, and only where it explains something: buttons shrink to 0.97 when
pressed, menus grow from 0.95 out of their button, the phone sheet slides up once when it opens, toasts
fade in. Row selection, tab changes and hover stay instant. All of it is switched off by
`prefers-reduced-motion`.

## Before shipping a UI change

1. Tests: `node --test tests/code.test.js tests/sync.test.js`
2. Preview: `node dev/serve.js`, open `http://localhost:8765/?seed`
3. Check 320, 390, 768, 1024 and 1440px wide, light and dark.
4. Worst-case content: a 120-character company name, a 60-character requisition ID, 2,000 characters of
   notes, 150 jobs, emoji and CJK text. Nothing should widen the page or break a layout.
5. Keyboard only: every control reachable, focus always visible.
