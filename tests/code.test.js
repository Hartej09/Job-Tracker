// Tests for Code.gs, run with:  node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('../dev/load-code.js');

function setup() {
  const env = loadCode();
  env.gas.setup();
  return env;
}

function add(env, overrides, force) {
  const data = Object.assign({ requisition_id: 'R-1001', company: 'Acme', role: 'Engineer' }, overrides);
  const result = env.json(env.gas.addJob(data, !!force));
  return result.job || result;
}

const history = (env, id) => env.json(env.gas.getHistory(id));
const jobs = (env) => env.json(env.gas.getAppData().jobs);

// --- Migrations --------------------------------------------------------------

test('setup creates sheets with headers and records the schema version', () => {
  const env = setup();
  const jobsSheet = env.ss.getSheetByName('Jobs');
  assert.deepEqual(env.json(jobsSheet.getRange(1, 1, 1, 16).getDisplayValues()[0]), env.json(env.gas.JOB_COLUMNS));
  assert.ok(env.ss.getSheetByName('StatusHistory'));
  assert.equal(env.store.schemaVersion, '2');
  assert.ok(jobsSheet.validations.length > 0, 'status dropdown validation applied');
});

test('migrations are idempotent and refuse a newer schema', () => {
  const env = setup();
  env.gas.setup();
  assert.equal(env.ss.sheets.filter((s) => s.name === 'Jobs').length, 1);
  env.store.schemaVersion = '99';
  assert.throws(() => env.gas.getAppData(), /newer version/);
});

test('the lock is always released, even after errors', () => {
  const env = setup();
  assert.throws(() => env.gas.addJob({ company: 'x' }, false));
  add(env);
  assert.equal(env.lock.held, 0);
});

// --- Adding & validation -------------------------------------------------------

test('addJob trims, defaults status to Applied and writes initial history', () => {
  const env = setup();
  const job = add(env, { requisition_id: '  R-1 ', company: ' Acme ', location: '   ', date_applied: '2026-03-04' });
  assert.equal(job.requisition_id, 'R-1');
  assert.equal(job.company, 'Acme');
  assert.equal(job.status, 'Applied');
  assert.equal(job.location, null);
  assert.equal(job.date_applied, '2026-03-04');
  assert.equal(job.created_at, job.updated_at);
  assert.match(job.created_at, /Z$/);
  assert.deepEqual(history(env, job.id).map((h) => [h.old_status, h.new_status, h.source]), [[null, 'Applied', 'manual']]);
});

for (const field of ['requisition_id', 'company', 'role']) {
  for (const value of [undefined, '', '   ']) {
    test(`addJob requires ${field} (${JSON.stringify(value)})`, () => {
      const env = setup();
      const data = { requisition_id: 'R1', company: 'Acme', role: 'Eng' };
      if (value === undefined) delete data[field];
      else data[field] = value;
      assert.throws(() => env.gas.addJob(data, false), /is required/);
      assert.equal(jobs(env).length, 0);
    });
  }
}

test('addJob rejects bad status and dates', () => {
  const env = setup();
  assert.throws(() => add(env, { status: 'Hired' }), /Status must be one of/);
  assert.throws(() => add(env, { date_applied: '03/04/2026' }), /Date applied must be a valid date/);
  assert.throws(() => add(env, { follow_up: '2026-02-30' }), /Follow-up must be a valid date/);
});

test('duplicates (case-insensitive, trimmed) warn first, then add when forced', () => {
  const env = setup();
  add(env, { company: 'Acme Corp', requisition_id: 'REQ-77' });
  const warned = add(env, { company: ' acme corp ', requisition_id: 'req-77' });
  assert.equal(warned.duplicates.length, 1);
  assert.equal(jobs(env).length, 1);
  const forced = add(env, { company: ' acme corp ', requisition_id: 'req-77' }, true);
  assert.ok(forced.id);
  assert.equal(jobs(env).length, 2);
});

test('text that looks like a formula is stored as text', () => {
  const env = setup();
  const job = add(env, { company: '=HYPERLINK("x")' });
  assert.equal(jobs(env)[0].company, '=HYPERLINK("x")');
  assert.equal(job.company, '=HYPERLINK("x")');
});

// --- Updating & status changes ------------------------------------------------

test('updateJob changes fields without touching history', () => {
  const env = setup();
  const job = add(env);
  const updated = env.json(env.gas.updateJob(job.id, { notes: ' called ', follow_up: '2026-05-01' }, job.updated_at));
  assert.equal(updated.notes, 'called');
  assert.equal(updated.follow_up, '2026-05-01');
  assert.ok(updated.updated_at > job.updated_at);
  assert.equal(history(env, job.id).length, 1);
});

test('status changes write history; any transition allowed; same status is a no-op', () => {
  const env = setup();
  const job = add(env);
  let current = env.json(env.gas.updateJob(job.id, { status: 'Interviewing', notes: 'screen' }, job.updated_at));
  current = env.json(env.gas.updateJob(job.id, { status: 'Applied' }, current.updated_at));
  const unchanged = env.json(env.gas.updateJob(job.id, { status: 'Applied' }, current.updated_at));
  assert.equal(unchanged.updated_at, current.updated_at);
  const h = history(env, job.id);
  assert.deepEqual(h.map((x) => [x.old_status, x.new_status, x.source]), [
    [null, 'Applied', 'manual'], ['Applied', 'Interviewing', 'manual'], ['Interviewing', 'Applied', 'manual'],
  ]);
  assert.equal(h[2].changed_at, current.updated_at);
});

test('changeStatus_ records the given source', () => {
  const env = setup();
  const job = add(env);
  env.gas.changeStatus_(job.id, 'Ghosted', 'inactivity');
  assert.equal(history(env, job.id)[1].source, 'inactivity');
  assert.throws(() => env.gas.changeStatus_(job.id, 'Offer', 'robot'), /Unknown history source/);
});

test('stale updated_at is a conflict and changes nothing', () => {
  const env = setup();
  const job = add(env);
  env.gas.updateJob(job.id, { notes: 'elsewhere' }, job.updated_at);
  assert.throws(() => env.gas.updateJob(job.id, { notes: 'mine' }, job.updated_at), /^Error: CONFLICT: /);
  assert.equal(jobs(env)[0].notes, 'elsewhere');
  assert.throws(() => env.gas.updateJob(999, { notes: 'x' }, null), /CONFLICT: that job no longer exists/);
});

test('required fields cannot be blanked on update', () => {
  const env = setup();
  const job = add(env);
  assert.throws(() => env.gas.updateJob(job.id, { company: '  ' }, job.updated_at), /Company is required/);
  assert.equal(jobs(env)[0].company, 'Acme');
});

test('status change is undone if the history write fails', () => {
  const env = setup();
  const job = add(env);
  env.ss.getSheetByName('StatusHistory').failNextWrite = true;
  assert.throws(() => env.gas.updateJob(job.id, { status: 'Offer', notes: 'new' }, job.updated_at), /Simulated/);
  const after = jobs(env)[0];
  assert.equal(after.status, 'Applied');
  assert.equal(after.notes, null);
  assert.equal(after.updated_at, job.updated_at);
  assert.equal(history(env, job.id).length, 1);
});

test('a new job is removed again if its history write fails', () => {
  const env = setup();
  env.ss.getSheetByName('StatusHistory').failNextWrite = true;
  assert.throws(() => add(env), /Simulated/);
  assert.equal(jobs(env).length, 0);
});

// --- Deleting ------------------------------------------------------------------

test('deleteJob removes the job and only its history; ids are not reused', () => {
  const env = setup();
  const a = add(env, { requisition_id: 'A' });
  const b = add(env, { requisition_id: 'B' });
  env.gas.updateJob(a.id, { status: 'Offer' }, a.updated_at);
  env.gas.deleteJob(a.id);
  assert.deepEqual(jobs(env).map((j) => j.id), [b.id]);
  assert.equal(history(env, a.id).length, 0);
  assert.equal(history(env, b.id).length, 1);
  // B's row moved up; it must still be editable.
  env.gas.updateJob(b.id, { notes: 'still here' }, b.updated_at);
  assert.equal(jobs(env)[0].notes, 'still here');
  const c = add(env, { requisition_id: 'C' });
  assert.ok(c.id > b.id);
  assert.throws(() => env.gas.deleteJob(a.id), /CONFLICT/);
});

test('many rows: the sheet grows past its initial size', () => {
  const env = setup();
  const records = [];
  for (let i = 0; i < 1100; i++) {
    records.push({ _row: i + 2, requisition_id: 'R' + i, company: 'Co', role: 'Eng' });
  }
  const result = env.json(env.gas.importJobs(records));
  assert.equal(result.inserted, 1100);
  assert.equal(jobs(env).length, 1100);
});

// --- Lists, follow-ups, stats, export -------------------------------------------

test('jobs sort newest applied first, undated last', () => {
  const env = setup();
  add(env, { requisition_id: '1', date_applied: '2026-01-01' });
  add(env, { requisition_id: '2' });
  add(env, { requisition_id: '3', date_applied: '2026-02-01' });
  assert.deepEqual(jobs(env).map((j) => j.requisition_id), ['3', '1', '2']);
});

test('follow-ups due: today or earlier, excluding Rejected/Withdrawn/Offer', () => {
  const env = setup();
  const list = [
    { id: 1, follow_up: '2026-10-01', status: 'Applied' },
    { id: 2, follow_up: '2026-10-09', status: 'Interviewing' },
    { id: 3, follow_up: '2026-10-10', status: 'Applied' },
    { id: 4, follow_up: null, status: 'Applied' },
    { id: 5, follow_up: '2026-10-01', status: 'Rejected' },
    { id: 6, follow_up: '2026-10-01', status: 'Withdrawn' },
    { id: 7, follow_up: '2026-10-01', status: 'Offer' },
    { id: 8, follow_up: '2026-09-01', status: 'Ghosted' },
  ];
  assert.deepEqual(env.json(env.gas.followUpsDue_(list, '2026-10-09').map((j) => j.id)), [8, 1, 2]);
});

test('counts include every status; weeks start Monday with gaps filled', () => {
  const env = setup();
  const list = [
    { status: 'Applied', date_applied: '2026-10-05' }, // Monday
    { status: 'Applied', date_applied: '2026-10-11' }, // Sunday, same week
    { status: 'Offer', date_applied: '2026-10-26' },
    { status: 'Applied', date_applied: null },
  ];
  const counts = env.json(env.gas.countByStatus_(list));
  assert.deepEqual(Object.keys(counts), env.json(env.gas.STATUSES));
  assert.equal(counts.Applied, 3);
  assert.equal(counts.Ghosted, 0);
  assert.deepEqual(env.json(env.gas.applicationsPerWeek_(list)), [
    { week: '2026-10-05', count: 2 }, { week: '2026-10-12', count: 0 },
    { week: '2026-10-19', count: 0 }, { week: '2026-10-26', count: 1 },
  ]);
});

test('getAppData reports follow-ups for today in the sheet time zone', () => {
  const env = setup();
  const today = env.gas.today_();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  const due = add(env, { requisition_id: 'D', follow_up: today });
  add(env, { requisition_id: 'F', follow_up: '2999-01-01' });
  const data = env.json(env.gas.getAppData());
  assert.deepEqual(data.followUpIds, [due.id]);
  assert.equal(data.today, today);
});

test('exportCsv quotes, escapes formulas and keeps the requested order', () => {
  const env = setup();
  const a = add(env, { requisition_id: 'A', company: 'Acme, Inc.', notes: 'said "hi"\nnext line' });
  const b = add(env, { requisition_id: 'B', company: '=cmd' });
  const csv = env.gas.exportCsv([b.id, a.id, 999]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], env.json(env.gas.JOB_COLUMNS).join(','));
  assert.match(lines[1], /^\d+,B,'=cmd,/);
  assert.ok(csv.includes('"Acme, Inc."'));
  assert.ok(csv.includes('"said ""hi""\nnext line"'));
});

// --- CSV parsing & mapping --------------------------------------------------------

test('parseCsv_ handles BOM, quotes, commas, newlines and CRLF', () => {
  const env = setup();
  const rows = env.json(env.gas.parseCsv_('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",\n'));
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'multi\nline', '']]);
});

test('normalizeHeader_ ignores case, spaces and punctuation', () => {
  const env = setup();
  assert.equal(env.gas.normalizeHeader_('Req. #'), 'req');
  assert.equal(env.gas.normalizeHeader_(' Requisition_ID '), 'requisitionid');
  assert.equal(env.gas.normalizeHeader_('Follow-Up'), 'followup');
  assert.equal(env.gas.normalizeHeader_('Société'), 'société');
});

test('suggestMapping_: exact names, aliases, unmatched headers, one use per header', () => {
  const env = setup();
  const exact = env.json(env.gas.suggestMapping_(['REQUISITION ID', 'company', 'Role', 'date-applied', 'Job URL', 'e-mail domain', 'NOTES']));
  assert.equal(exact.requisition_id, 'REQUISITION ID');
  assert.equal(exact.date_applied, 'date-applied');
  assert.equal(exact.email_domain, 'e-mail domain');
  assert.equal(exact.location, null);
  const messy = env.json(env.gas.suggestMapping_(['Req #', 'Hiring Co.', 'Position', 'Applied On', 'Stage', 'City', 'Next Follow-Up', 'Comments']));
  assert.equal(messy.requisition_id, 'Req #');
  assert.equal(messy.role, 'Position');
  assert.equal(messy.status, 'Stage');
  assert.equal(messy.follow_up, 'Next Follow-Up');
  assert.equal(messy.company, null);
  const priority = env.json(env.gas.suggestMapping_(['Title', 'Role', 'Requisition', 'Requisition ID']));
  assert.equal(priority.role, 'Role');
  assert.equal(priority.requisition_id, 'Requisition ID');
});

const GOOD_DATES = [
  ['2026-03-04', '2026-03-04'], ['03/04/2026', '2026-03-04'], ['3/4/2026', '2026-03-04'],
  ['3/4/26', '2026-03-04'], ['03-04-2026', '2026-03-04'], ['3.4.2026', '2026-03-04'],
  ['2026/03/04', '2026-03-04'], ['20260304', '2026-03-04'], ['Mar 4 2026', '2026-03-04'],
  ['March 4, 2026', '2026-03-04'], ['Sept 4, 2026', '2026-09-04'], ['4 Mar 2026', '2026-03-04'],
  ['04-Mar-2026', '2026-03-04'], ['04-Mar-26', '2026-03-04'], ['Mar-04-2026', '2026-03-04'],
  ['2026-03-04T10:15:00Z', '2026-03-04'], ['3/4/2026 2:15 PM', '2026-03-04'], ['  03/04/2026 ', '2026-03-04'],
  ['2/29/2028', '2028-02-29'],
];
for (const [text, iso] of GOOD_DATES) {
  test(`parseDate_ reads "${text}"`, () => {
    const env = setup();
    assert.deepEqual(env.json(env.gas.parseDate_(text)), { iso, ok: true });
  });
}
for (const text of ['not a date', '13/01/2026', '02/30/2026', '2026-13-01', 'yesterday', 'Ma 4 2026', '2/29/2026']) {
  test(`parseDate_ rejects "${text}"`, () => {
    const env = setup();
    assert.deepEqual(env.json(env.gas.parseDate_(text)), { iso: null, ok: false });
  });
}
test('parseDate_ treats blank as no date', () => {
  const env = setup();
  for (const v of ['', '   ', null]) assert.deepEqual(env.json(env.gas.parseDate_(v)), { iso: null, ok: true });
});

test('parseStatus_ is case-insensitive; blank is Applied; unknown is null', () => {
  const env = setup();
  assert.equal(env.gas.parseStatus_('interviewing'), 'Interviewing');
  assert.equal(env.gas.parseStatus_(' OFFER '), 'Offer');
  assert.equal(env.gas.parseStatus_(''), 'Applied');
  assert.equal(env.gas.parseStatus_('Phone screen'), null);
});

// --- Import flow ----------------------------------------------------------------------

const MESSY_CSV =
  'Req #,Hiring Co.,Position,Applied On,Stage,City,Next Follow-Up,Comments\n' +
  'R-100,Acme,Engineer,03/04/2026,interviewing,Austin,3/11/26,first\n' +
  ',Globex,Analyst,2026-03-05,,Remote,,missing req\n' +
  'R-300,Initech,PM,not a date,Applied,,,bad date\n' +
  'r-100,ACME,Engineer II,Mar 6 2026,Applied,,,dup of row 2\n' +
  'R-400,Umbrella,,03/07/2026,Phone screen,,,missing role + bad status\n' +
  ',,,,,,,\n' +
  'R-500,Hooli,SRE,"March 8, 2026",Rejected,,,\n';

function recordsFor(parsed, mapping) {
  return parsed.rows.map((r) => {
    const rec = { _row: r._row };
    for (const [field, header] of Object.entries(mapping)) {
      rec[field] = header ? r.values[parsed.headers.indexOf(header)] : '';
    }
    return rec;
  });
}

test('parseImportFile keeps spreadsheet row numbers and drops blank rows', () => {
  const env = setup();
  const parsed = env.json(env.gas.parseImportFile(MESSY_CSV));
  assert.deepEqual(parsed.rows.map((r) => r._row), [2, 3, 4, 5, 6, 8]);
  assert.equal(parsed.mapping.company, null);
  assert.throws(() => env.gas.parseImportFile(''), /empty/);
});

test('checkImport finds missing fields, bad dates, unknown statuses and duplicates', () => {
  const env = setup();
  add(env, { requisition_id: 'R-500', company: 'hooli', role: 'SRE' });
  const parsed = env.json(env.gas.parseImportFile(MESSY_CSV));
  const mapping = Object.assign({}, parsed.mapping, { company: 'Hiring Co.' });
  const plan = env.json(env.gas.checkImport(recordsFor(parsed, mapping)));

  assert.deepEqual(plan.ready.map((r) => r._row), [2]);
  assert.equal(plan.ready[0].date_applied, '2026-03-04');
  assert.equal(plan.ready[0].follow_up, '2026-03-11');
  assert.equal(plan.ready[0].status, 'Interviewing');

  const invalid = Object.fromEntries(plan.invalid.map((i) => [i.raw._row, i.problems]));
  assert.deepEqual(invalid[3], ['missing Requisition ID']);
  assert.deepEqual(invalid[4], ['unrecognized Date applied "not a date"']);
  assert.deepEqual(invalid[6], ['missing Role', 'unknown status "Phone screen"']);
  const fields = Object.fromEntries(plan.invalid.map((i) => [i.raw._row, i.fields]));
  assert.deepEqual(fields[3], ['requisition_id']);
  assert.deepEqual(fields[4], ['date_applied']);
  assert.deepEqual(fields[6], ['role', 'status']);

  const dups = Object.fromEntries(plan.duplicates.map((d) => [d.record._row, d.reason]));
  assert.deepEqual(dups, { 5: 'duplicate of row 2 in this file', 8: 'already in tracker' });
});

test('fixed rows become ready; cleared bad dates import as blank', () => {
  const env = setup();
  const parsed = env.json(env.gas.parseImportFile(MESSY_CSV));
  const mapping = Object.assign({}, parsed.mapping, { company: 'Hiring Co.' });
  const records = recordsFor(parsed, mapping);
  const byRow = Object.fromEntries(records.map((r) => [r._row, r]));
  byRow[3].requisition_id = 'G-1';
  byRow[4].date_applied = '';
  byRow[6].role = 'Analyst';
  byRow[6].status = 'Interviewing';
  const plan = env.json(env.gas.checkImport(Object.values(byRow)));
  assert.deepEqual(plan.ready.map((r) => r._row), [2, 3, 4, 6, 8]);
  assert.equal(plan.invalid.length, 0);
  assert.equal(plan.ready.find((r) => r._row === 4).date_applied, null);
});

test('importJobs writes import history and skips duplicates, re-checked at import time', () => {
  const env = setup();
  add(env, { requisition_id: 'R-1', company: 'Acme', role: 'Eng' });
  const result = env.json(env.gas.importJobs([
    { _row: 2, requisition_id: 'R-2', company: 'Globex', role: 'Analyst', status: 'Offer' },
    { _row: 3, requisition_id: 'r-1', company: 'ACME', role: 'Eng' },
    { _row: 4, requisition_id: 'R-2', company: 'globex', role: 'Analyst' },
    { _row: 5, requisition_id: 'R-3', company: 'Initech', role: 'PM', date_applied: '2026-03-04' },
  ]));
  assert.equal(result.inserted, 2);
  assert.deepEqual(result.skipped.map((s) => s._row), [3, 4]);
  const imported = jobs(env).filter((j) => j.company !== 'Acme');
  assert.deepEqual(imported.map((j) => j.status).sort(), ['Applied', 'Offer']);
  for (const j of imported) {
    assert.deepEqual(history(env, j.id).map((h) => [h.old_status, h.source]), [[null, 'import']]);
  }
});

test('importJobs is all-or-nothing when a row is invalid', () => {
  const env = setup();
  assert.throws(() => env.gas.importJobs([
    { _row: 2, requisition_id: 'R-1', company: 'Acme', role: 'Eng' },
    { _row: 3, requisition_id: 'R-2', company: 'Globex', role: '' },
  ]), /row 3: missing Role/);
  assert.equal(jobs(env).length, 0);
});

// --- Edits made directly in the sheet ------------------------------------------------

function editCell(env, row, column, value, oldValue) {
  const sheet = env.ss.getSheetByName('Jobs');
  const col = env.gas.JOB_COLUMNS.indexOf(column) + 1;
  const range = sheet.getRange(row, col);
  range.setValue(value);
  env.gas.onEdit({ range, value, oldValue, source: env.ss });
}

test('onEdit records single-cell status changes and bumps updated_at', () => {
  const env = setup();
  const job = add(env);
  editCell(env, 2, 'status', 'Interviewing', 'Applied');
  const h = history(env, job.id);
  assert.deepEqual([h[1].old_status, h[1].new_status, h[1].source], ['Applied', 'Interviewing', 'manual']);
  assert.ok(jobs(env)[0].updated_at > job.updated_at);
});

test('onEdit reverts a cleared status and converts typed dates', () => {
  const env = setup();
  add(env);
  editCell(env, 2, 'status', undefined, 'Applied');
  assert.equal(jobs(env)[0].status, 'Applied');
  assert.match(env.ss.toasts[0].message, /Status must be one of/);
  editCell(env, 2, 'follow_up', '3/4/2026', undefined);
  assert.equal(jobs(env)[0].follow_up, '2026-03-04');
  editCell(env, 2, 'follow_up', 'soon', undefined);
  assert.match(env.ss.toasts[1].title, /Unrecognized date/);
});

test('onEdit ignores other sheets and the header row; warns on multi-cell status edits', () => {
  const env = setup();
  const job = add(env);
  const history0 = history(env, job.id).length;
  const hist = env.ss.getSheetByName('StatusHistory');
  env.gas.onEdit({ range: hist.getRange(2, 1), value: 'x', source: env.ss });
  const jobsSheet = env.ss.getSheetByName('Jobs');
  env.gas.onEdit({ range: jobsSheet.getRange(1, 1), value: 'x', source: env.ss });
  assert.equal(env.ss.toasts.length, 0);
  env.gas.onEdit({ range: jobsSheet.getRange(2, 2, 1, 6), source: env.ss });
  assert.match(env.ss.toasts[0].message, /one cell at a time/);
  assert.equal(history(env, job.id).length, history0);
});
