// Phase 2 tests: classifier, matcher, Gmail sync, ghost check, Review actions.
// Gmail is the in-memory FakeGmail from dev/gas-mocks.js; no network calls.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('../dev/load-code.js');

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY);

/** Sheets set up (schema v2) but no Gmail sync yet. */
function fresh(options) {
  const env = loadCode(options);
  env.gas.getAppData();
  return env;
}

/** Fully set up: first sync done (empty mailbox), so new mail arrives via history. */
function synced() {
  const env = loadCode();
  env.gas.setup();
  return env;
}

function add(env, overrides) {
  const data = Object.assign({ requisition_id: 'R-10001', company: 'Acme', role: 'Engineer' }, overrides);
  return env.json(env.gas.addJob(data, true)).job;
}

const sync = (env) => env.json(env.gas.syncNow());
const review = (env) => env.json(env.gas.getAppData().review);
const allSuggestions = (env) => env.json(env.gas.readSuggestions_());
const jobById = (env, id) => env.json(env.gas.getAppData().jobs.find((j) => j.id === id));
const history = (env, id) => env.json(env.gas.getHistory(id));

function setSetting(env, key, value) {
  const sheet = env.ss.getSheetByName('Settings');
  const rows = sheet.dump();
  const i = rows.findIndex((r) => r[0] === key);
  sheet.getRange(i + 2, 2).setValue(value);
}

// --- Classifier -----------------------------------------------------------------

const CLASSIFY = [
  ['We are pleased to extend an offer of employment for the role.', 'offer'],
  ['Attached is your offer letter.', 'offer'],
  ['Unfortunately, we have decided to move forward with other candidates.', 'rejection'],
  ['We regret to inform you that the position has been filled.', 'rejection'],
  ['We are unable to extend an offer at this time.', 'rejection'],
  ['Unfortunately we need to reschedule your interview to Thursday.', 'interview'],
  ['Unfortunately, I have to move our call — can we find a time next week?', 'interview'],
  ['We would like to invite you to interview with the team.', 'interview'],
  ['Please book a time for a phone screen.', 'interview'],
  ['Thank you for applying! If you are selected for an interview, we will contact you.', 'confirmation'],
  ['Thank you for your application. We have received your application for Engineer.', 'confirmation'],
  ['Thank you for your interest. Unfortunately the role has been filled.', 'rejection'],
  ['We are delighted to extend an offer! Unfortunately the start date must move.', 'offer'],
  ['Your weekly digest of new posts', null],
];
for (const [text, expected] of CLASSIFY) {
  test(`classify: "${text.slice(0, 50)}…" -> ${expected}`, () => {
    const env = fresh();
    assert.equal(env.gas.classify_(text, env.gas.readRules_().rules), expected);
  });
}

test('rules come from the Rules tab and can be edited; bad rows are reported', () => {
  const env = fresh();
  const rulesSheet = env.ss.getSheetByName('Rules');
  const rows = rulesSheet.dump();
  const reschedule = rows.findIndex((r) => r[0] === 'rejection' && r[2] === 'reschedul');
  rulesSheet.getRange(reschedule + 2, 1, 1, 4).clearContent(); // remove the exclusion
  const text = 'Unfortunately we need to reschedule your interview';
  const loaded = env.gas.readRules_();
  // Without the exclusion, "unfortunately" wins (rejection outranks interview).
  assert.equal(env.gas.classify_(text, loaded.rules), 'rejection');
  rulesSheet.getRange(rows.length + 2, 1, 1, 3).setValues([['offer', 'include', '([unclosed']]);
  rulesSheet.getRange(rows.length + 3, 1, 1, 3).setValues([['nonsense', 'include', 'x']]);
  const problems = env.json(env.gas.readRules_().problems);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /invalid pattern/);
});

// --- Matcher --------------------------------------------------------------------

function match(env, jobs, email) {
  const settings = env.gas.readSettings_();
  const matcher = env.gas.buildMatcher_(jobs, settings);
  const e = Object.assign({ subject: '', body: '' }, email, { sender: env.gas.parseSender_(email.from || '') });
  const result = env.gas.matchJob_(e, matcher, settings);
  return result && env.json({ id: result.job ? result.job.id : null, by: result.matchedBy || null, ambiguous: result.ambiguous || null });
}

const J = (id, o) => Object.assign({ id, requisition_id: 'R-' + id, company: 'Co' + id, role: 'Eng', status: 'Applied', email_domain: null }, o);

test('rule a: requisition ID as a whole word in subject or body', () => {
  const env = fresh();
  const jobs = [J(1, { requisition_id: 'R-10012' }), J(2, { requisition_id: 'JR55555' })];
  assert.deepEqual(match(env, jobs, { from: 'x@y.com', body: 'Ref: R-10012.' }), { id: 1, by: 'requisition_id', ambiguous: null });
  assert.deepEqual(match(env, jobs, { from: 'x@y.com', subject: 'Re: jr55555 next steps' }), { id: 2, by: 'requisition_id', ambiguous: null });
  assert.equal(match(env, jobs, { from: 'x@y.com', body: 'R-100123 and XR-10012' }), null);
});

test('rule a ignores IDs shorter than 5 characters', () => {
  const env = fresh();
  const jobs = [J(1, { requisition_id: '1234', company: 'Initech' })];
  assert.equal(match(env, jobs, { from: 'x@y.com', subject: 'Job 1234' }), null);
  // ...so a later rule can still match.
  assert.deepEqual(match(env, jobs, { from: 'Initech Careers <x@y.com>', subject: 'Job 1234' }), { id: 1, by: 'company', ambiguous: null });
});

test('rule b: sender domain, except shared ATS domains', () => {
  const env = fresh();
  const jobs = [J(1, { email_domain: '@Acme.com' }), J(2, { email_domain: 'greenhouse.io', company: 'Globex' })];
  assert.deepEqual(match(env, jobs, { from: 'Talent <jobs@acme.com>' }), { id: 1, by: 'email_domain', ambiguous: null });
  // An ATS sender never matches by domain; the company name still can.
  assert.equal(match(env, jobs, { from: 'no-reply@greenhouse.io', subject: 'Your application' }), null);
  assert.deepEqual(match(env, jobs, { from: 'Globex via Greenhouse <no-reply@us.greenhouse.io>' }), { id: 2, by: 'company', ambiguous: null });
});

test('rule c: company name as a whole word in sender name or subject', () => {
  const env = fresh();
  const jobs = [J(1, { company: 'Acme' }), J(2, { company: 'Globex Corp' })];
  assert.deepEqual(match(env, jobs, { from: 'x@y.com', subject: 'Update from ACME' }), { id: 1, by: 'company', ambiguous: null });
  assert.deepEqual(match(env, jobs, { from: 'Globex Corp Recruiting <x@y.com>' }), { id: 2, by: 'company', ambiguous: null });
  assert.equal(match(env, jobs, { from: 'x@y.com', subject: 'Acmeco newsletter' }), null);
  assert.equal(match(env, jobs, { from: 'Globex <x@y.com>' }), null, 'the full company name is needed');
  // "Acme Labs" contains the whole word "Acme" too, so both jobs match → ambiguous → ignored.
  const overlap = [J(1, { company: 'Acme' }), J(2, { company: 'Acme Labs' })];
  assert.deepEqual(match(env, overlap, { from: 'x@y.com', subject: 'Update from Acme Labs' }), { id: null, by: null, ambiguous: 'company' });
});

test('ambiguous matches narrow to open jobs, otherwise the email is ignored', () => {
  const env = fresh();
  const two = [J(1, { company: 'Acme' }), J(2, { company: 'Acme' })];
  assert.deepEqual(match(env, two, { from: 'Acme <x@y.com>' }), { id: null, by: null, ambiguous: 'company' });
  two[0].status = 'Rejected';
  assert.deepEqual(match(env, two, { from: 'Acme <x@y.com>' }), { id: 2, by: 'company', ambiguous: null });
  // Ambiguity at an earlier rule stops matching; it doesn't fall through.
  const sameId = [J(1, { requisition_id: 'R-55555', email_domain: 'acme.com' }), J(2, { requisition_id: 'R-55555' })];
  assert.deepEqual(match(env, sameId, { from: 'jobs@acme.com', body: 'R-55555' }), { id: null, by: null, ambiguous: 'requisition_id' });
});

// --- Sync ---------------------------------------------------------------------------

test('first sync looks back 60 days using the configured query', () => {
  const env = fresh();
  const job = add(env, { requisition_id: 'R-20417' });
  env.gmail.add({ from: 'Acme <jobs@acme.com>', subject: 'Your application R-20417', body: 'Unfortunately we will not be moving forward.', date: inDays(-10) });
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-20417', body: 'Unfortunately…', date: inDays(-70) });
  env.gmail.add({ from: 'deals@acme.com', subject: 'R-20417 sale', body: 'Unfortunately…', labels: ['CATEGORY_PROMOTIONS'] });
  const result = sync(env);
  assert.equal(result.processed, 1);
  assert.equal(env.gmail.calls.get, 1);
  const r = review(env);
  assert.equal(r.suggestions.length, 1);
  assert.deepEqual([r.suggestions[0].job.id, r.suggestions[0].suggested_status, r.suggestions[0].matched_by],
    [job.id, 'Rejected', 'requisition_id']);
  assert.equal(r.backfillInProgress, false);
  assert.ok(r.lastSyncAt);
  assert.equal(jobById(env, job.id).status, 'Applied', 'never changes status by itself');
});

test('only subject, sender, date and snippet are stored — never the body', () => {
  const env = fresh();
  add(env);
  const body = 'Unfortunately we went another way. ' + 'x'.repeat(200) + ' BODY-ONLY-SECRET';
  env.gmail.add({ from: 'Acme Talent <talent@acme.com>', subject: 'About R-10001', body });
  sync(env);
  const s = allSuggestions(env)[0];
  assert.equal(s.subject, 'About R-10001');
  assert.equal(s.sender, 'Acme Talent <talent@acme.com>');
  assert.ok(s.snippet.startsWith('Unfortunately'));
  assert.match(s.email_date, /Z$/);
  for (const sheet of env.ss.sheets) {
    for (const row of sheet.rows) assert.ok(!row.join('|').includes('BODY-ONLY-SECRET'), sheet.name);
  }
});

test('HTML-only emails are read as text', () => {
  const env = fresh();
  add(env);
  env.gmail.add({ from: 'x@acme.com', subject: 'Update', html: '<p>Re: <b>R-10001</b></p><p>Unfortunately&nbsp;not this time</p>' });
  sync(env);
  assert.equal(allSuggestions(env)[0].suggested_status, 'Rejected');
});

test('incremental sync uses history and still applies the query', () => {
  const env = synced();
  const job = add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'Interview for R-10001', body: 'We would like to invite you to interview.' });
  env.gmail.add({ from: 'promo@acme.com', subject: 'R-10001 offer letter template', body: 'offer letter', labels: ['CATEGORY_PROMOTIONS'] });
  const before = env.gmail.calls.history;
  const result = sync(env);
  assert.equal(env.gmail.calls.history, before + 1);
  assert.equal(result.processed, 1);
  assert.deepEqual(review(env).suggestions.map((s) => s.suggested_status), ['Interviewing']);
  assert.equal(jobById(env, job.id).last_email_at !== null, true);
});

test('suggestions are deduped; dismissed and accepted emails are never re-suggested', () => {
  const env = synced();
  add(env);
  const id = env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately no.' });
  sync(env);
  sync(env);
  assert.equal(allSuggestions(env).length, 1);
  env.gas.dismissSuggestion(allSuggestions(env)[0].id);
  // Force the same message to be seen again.
  env.store.gmailHistoryId = '1';
  sync(env);
  const all = allSuggestions(env);
  assert.equal(all.length, 1);
  assert.equal(all[0].state, 'dismissed');
  assert.equal(all[0].dedupe_key, 'gmail:' + id);
});

test('no suggestion when the email matches the current status or is a confirmation, but activity is recorded', () => {
  const env = synced();
  const job = add(env, { status: 'Interviewing' });
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001 interview', body: 'Your interview is confirmed.', date: inDays(-1) });
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Thank you for applying.', date: inDays(0) });
  sync(env);
  assert.equal(allSuggestions(env).length, 0);
  assert.ok(jobById(env, job.id).last_email_at);
});

test('expired history id falls back to a search since the last sync', () => {
  const env = synced();
  add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately not this time.' });
  env.gmail.oldestHistoryId = 999999; // every stored id is now "too old"
  const result = sync(env);
  assert.equal(result.usedFallback, true);
  assert.equal(allSuggestions(env).length, 1);
  assert.equal(env.store.gmailHistoryId, String(env.gmail.historyId));
});

test('a sync that runs out of time resumes where it stopped', () => {
  const env = fresh();
  add(env);
  for (let i = 0; i < 3; i++) {
    env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001 #' + i, body: 'Unfortunately no.', date: inDays(-i - 1) });
  }
  const first = env.json(env.gas.syncGmail_({ budgetMs: -1 }));
  assert.equal(first.more, true);
  assert.equal(first.processed, 0);
  assert.ok(env.store.gmailBackfillQuery);
  const second = env.json(env.gas.syncGmail_({ budgetMs: 60000 }));
  assert.equal(second.more, false);
  assert.equal(allSuggestions(env).length, 3);
  assert.equal(env.store.gmailBackfillQuery, undefined);
});

test("hitting Gmail's rate limit pauses the sync (not an error) and resumes without re-fetching", () => {
  const env = fresh();
  add(env);
  for (let i = 0; i < 5; i++) {
    env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001 #' + i, body: 'Unfortunately no.', date: inDays(-i - 1) });
  }
  env.gmail.quotaLeft = 2;
  const first = env.json(env.gas.syncGmail_({ budgetMs: 25000 })); // too little time to wait a minute
  assert.equal(first.rateLimited, true);
  assert.equal(first.more, true);
  assert.equal(first.error, undefined);
  assert.equal(review(env).lastSyncError, null);
  assert.equal(allSuggestions(env).length, 2, 'what was found before the limit is saved');
  assert.equal(review(env).backfillInProgress, true);

  env.gmail.quotaLeft = null; // the minute has passed
  const second = env.json(env.gas.syncGmail_({ budgetMs: 25000 }));
  assert.equal(second.more, false);
  assert.equal(allSuggestions(env).length, 5);
  assert.equal(env.gmail.calls.get, 5, 'no email is fetched twice');
  assert.equal(env.store.gmailCheckedIds, undefined);
});

test('with enough time left, the sync waits a minute at the rate limit and carries on', () => {
  const env = fresh();
  add(env);
  for (let i = 0; i < 3; i++) {
    env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001 #' + i, body: 'Unfortunately no.', date: inDays(-i - 1) });
  }
  env.gmail.quotaLeft = 1;
  const result = env.json(env.gas.syncGmail_({ budgetMs: 5 * 60 * 1000 }));
  assert.equal(result.more, false);
  assert.equal(result.rateLimited, undefined);
  assert.equal(allSuggestions(env).length, 3);
  assert.ok(env.state.slept >= 60000, 'waited for the limit to reset');
});

test('fetches are paced, and a rate limit while listing is also just a pause', () => {
  const env = synced();
  add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately no.' });
  const before = env.state.slept;
  sync(env);
  assert.ok(env.state.slept - before >= 100, 'pauses between fetches');

  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001 again', body: 'Unfortunately…' });
  env.gmail.historyList = () => { throw new Error('User-rate limit exceeded. Retry after 2026-10-09T20:00:00Z'); };
  const result = sync(env);
  assert.equal(result.rateLimited, true);
  assert.equal(result.error, undefined);
  assert.equal(review(env).lastSyncError, null);
});

test('sync errors are shown in the app and cleared by the next good sync', () => {
  const env = synced();
  add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately…' });
  const realGet = env.gmail.get.bind(env.gmail);
  env.gmail.get = () => { throw new Error('Internal error encountered.'); };
  const failed = sync(env);
  assert.match(failed.error, /Internal error/);
  assert.match(review(env).lastSyncError, /Internal error/);
  env.gmail.get = realGet;
  sync(env);
  assert.equal(review(env).lastSyncError, null);
  assert.equal(allSuggestions(env).length, 1);
});

test('only one sync runs at a time', () => {
  const env = synced();
  env.docLock.held = 1;
  assert.equal(sync(env).skipped, 'already-running');
  env.docLock.held = 0;
});

test('without Gmail the app works fully and sync is skipped silently', () => {
  const env = loadCode({ gmail: false });
  env.gas.setup();
  const job = add(env);
  const data = env.json(env.gas.getAppData());
  assert.equal(data.review.gmailAvailable, false);
  assert.equal(data.review.syncDue, false);
  assert.equal(sync(env).skipped, 'gmail-unavailable');
  env.gas.updateJob(job.id, { status: 'Interviewing' }, job.updated_at);
  assert.equal(env.json(env.gas.runGhostCheck_(inDays(30))), 1, 'ghost check still runs');
});

// --- Ghost (inactivity) suggestions -------------------------------------------------

test('ghost thresholds: Applied > 30 days, Interviewing > 21 days, nothing for other statuses', () => {
  const env = fresh();
  const applied = add(env, { requisition_id: 'A' });
  const interviewing = add(env, { requisition_id: 'I', status: 'Interviewing' });
  add(env, { requisition_id: 'O', status: 'Offer' });
  add(env, { requisition_id: 'X', status: 'Rejected' });
  assert.equal(env.gas.runGhostCheck_(inDays(20)), 0);
  assert.equal(env.gas.runGhostCheck_(inDays(22)), 1);
  assert.equal(env.gas.runGhostCheck_(inDays(29)), 0);
  assert.equal(env.gas.runGhostCheck_(inDays(31)), 1);
  const s = allSuggestions(env);
  assert.deepEqual(s.map((x) => x.job_id).sort(), [applied.id, interviewing.id].sort());
  for (const x of s) {
    assert.equal(x.kind, 'inactivity');
    assert.equal(x.suggested_status, 'Ghosted');
    assert.equal(x.gmail_message_id, null);
    assert.equal(x.subject, null);
    assert.match(x.dedupe_key, new RegExp('^ghost:' + x.job_id + ':\\d{4}-'));
  }
  assert.ok(review(env).suggestions.every((x) => x.kind === 'email' || x.inactive_days >= 0));
});

test('ghost thresholds come from the Settings tab', () => {
  const env = fresh();
  add(env);
  setSetting(env, 'ghost_applied_days', '10');
  assert.equal(env.gas.runGhostCheck_(inDays(11)), 1);
});

test('a dismissed ghost suggestion returns only after new activity and another quiet spell', () => {
  const env = synced();
  const job = add(env);
  assert.equal(env.gas.runGhostCheck_(inDays(31)), 1);
  env.gas.dismissSuggestion(allSuggestions(env)[0].id);
  assert.equal(env.gas.runGhostCheck_(inDays(45)), 0, 'same quiet spell: stays dismissed');
  // New activity: a matched confirmation email dated day 40.
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Thank you for applying.', date: inDays(40) });
  sync(env);
  assert.equal(jobById(env, job.id).last_email_at.slice(0, 10), inDays(40).toISOString().slice(0, 10));
  assert.equal(env.gas.runGhostCheck_(inDays(50)), 0, 'only 10 quiet days');
  assert.equal(env.gas.runGhostCheck_(inDays(71)), 1, 'quiet again for 31 days');
  assert.equal(allSuggestions(env).filter((s) => s.state === 'pending').length, 1);
});

test('new activity dismisses a stale pending ghost suggestion', () => {
  const env = fresh();
  const job = add(env);
  env.gas.runGhostCheck_(inDays(31));
  const current = jobById(env, job.id);
  env.gas.updateJob(job.id, { status: 'Offer' }, current.updated_at);
  env.gas.runGhostCheck_(inDays(32));
  assert.deepEqual(allSuggestions(env).map((s) => s.state), ['dismissed']);
});

// --- Review actions ---------------------------------------------------------------------

test('accepting an email suggestion changes status with source "email"', () => {
  const env = synced();
  const job = add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately not this time.' });
  sync(env);
  const data = env.json(env.gas.getAppData());
  assert.deepEqual(data.pendingJobIds, [job.id]);
  const s = data.review.suggestions[0];
  assert.equal(s.job.status, 'Applied');
  env.gas.acceptSuggestion(s.id);
  assert.equal(jobById(env, job.id).status, 'Rejected');
  assert.deepEqual(history(env, job.id).slice(-1).map((h) => [h.old_status, h.new_status, h.source]), [['Applied', 'Rejected', 'email']]);
  assert.equal(allSuggestions(env)[0].state, 'accepted');
  assert.equal(review(env).suggestions.length, 0);
  assert.throws(() => env.gas.acceptSuggestion(s.id), /CONFLICT: that suggestion was already accepted/);
});

test('"Accept as" uses the chosen status; accepting a ghost records source "inactivity"', () => {
  const env = synced();
  const a = add(env, { requisition_id: 'A-11111' });
  const b = add(env, { requisition_id: 'B-22222', company: 'Globex' });
  env.gmail.add({ from: 'jobs@acme.com', subject: 'A-11111', body: 'Unfortunately…' });
  sync(env);
  env.gas.acceptSuggestion(allSuggestions(env)[0].id, 'Withdrawn');
  assert.equal(jobById(env, a.id).status, 'Withdrawn');
  assert.throws(() => env.gas.acceptSuggestion(999, 'Offer'), /CONFLICT/);

  env.gas.runGhostCheck_(inDays(31));
  const ghost = allSuggestions(env).find((s) => s.kind === 'inactivity' && s.job_id === b.id);
  env.gas.acceptSuggestion(ghost.id);
  assert.equal(jobById(env, b.id).status, 'Ghosted');
  assert.equal(history(env, b.id).slice(-1)[0].source, 'inactivity');
  assert.equal(env.gas.runGhostCheck_(inDays(90)), 0, 'Ghosted jobs are not checked');
});

test('deleting a job deletes its suggestions', () => {
  const env = synced();
  const a = add(env, { requisition_id: 'A-11111' });
  add(env, { requisition_id: 'B-22222', company: 'Globex' });
  env.gas.runGhostCheck_(inDays(31));
  assert.equal(allSuggestions(env).length, 2);
  env.gas.deleteJob(a.id);
  assert.deepEqual(allSuggestions(env).map((s) => s.job_id).includes(a.id), false);
  assert.equal(allSuggestions(env).length, 1);
});

// --- Trigger, settings, migration ---------------------------------------------------------

test('setup installs the hourly trigger; changing auto_sync_hours updates it', () => {
  const env = synced();
  assert.deepEqual(env.triggers.map((t) => [t.spec.handler, t.spec.hours]), [['scheduledSync', 1]]);
  setSetting(env, 'auto_sync_hours', '6');
  sync(env);
  assert.deepEqual(env.triggers.map((t) => t.spec.hours), [6]);
  setSetting(env, 'auto_sync_hours', '3'); // not allowed: falls back to 1
  sync(env);
  assert.deepEqual(env.triggers.map((t) => t.spec.hours), [1]);
  setSetting(env, 'auto_sync_hours', '0');
  sync(env);
  assert.equal(env.triggers.length, 0);
  assert.equal(review(env).autoSyncHours, 0);
});

test('scheduledSync syncs and runs the ghost check', () => {
  const env = synced();
  add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately…' });
  env.gas.scheduledSync();
  assert.equal(allSuggestions(env).length, 1);
});

test('syncDue: opening the app syncs when the last sync is over 15 minutes old', () => {
  const env = synced();
  assert.equal(review(env).syncDue, false);
  env.store.gmailLastSyncAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  assert.equal(review(env).syncDue, true);
});

test('upgrading a Phase 1 sheet keeps data and shifts extra user columns right', () => {
  const env = loadCode();
  env.gas.MIGRATIONS[0](env.ss);
  env.store.schemaVersion = '1';
  const jobs = env.ss.getSheetByName('Jobs');
  const v1 = env.json(env.gas.JOB_COLUMNS_V1);
  const row = v1.map((c) => ({ id: '7', requisition_id: 'R-7', company: 'Acme', role: 'Eng', status: 'Applied',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' })[c] || '');
  jobs.getRange(1, 16).setValue('my notes');
  jobs.getRange(2, 1, 1, 15).setValues([row]);
  jobs.getRange(2, 16).setValue('call back Friday');
  const data = env.json(env.gas.getAppData());
  assert.equal(env.store.schemaVersion, '3');
  assert.equal(jobs.cell(1, 16), 'last_email_at');
  assert.equal(jobs.cell(1, 17), 'portal_url');
  assert.equal(jobs.cell(1, 18), 'my notes');
  assert.equal(jobs.cell(2, 18), 'call back Friday');
  assert.equal(data.jobs[0].company, 'Acme');
  assert.equal(data.jobs[0].last_email_at, null);
  for (const name of ['Suggestions', 'Settings', 'Rules']) assert.ok(env.ss.getSheetByName(name), name);
  assert.equal(env.ss.getSheetByName('Settings').dump().length, env.gas.DEFAULT_SETTINGS.length);
});

test('reopenSuggestion puts an accepted or dismissed suggestion back in the pending list', () => {
  const env = synced();
  const job = add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately not this time.' });
  sync(env);
  const s = review(env).suggestions[0];
  env.gas.acceptSuggestion(s.id);
  env.gas.updateJob(job.id, { status: 'Applied' });
  assert.equal(review(env).suggestions.length, 0);
  env.gas.reopenSuggestion(s.id);
  assert.equal(review(env).suggestions.length, 1);
  assert.equal(allSuggestions(env)[0].state, 'pending');
  env.gas.dismissSuggestion(s.id);
  env.gas.reopenSuggestion(s.id);
  assert.equal(review(env).suggestions.length, 1);
  assert.throws(() => env.gas.reopenSuggestion(999), /CONFLICT/);
});

test('undoSuggestion restores the status and keeps a quiet-check suggestion valid', () => {
  const env = synced();
  const job = add(env);
  env.gas.runGhostCheck_(inDays(31));
  const ghost = allSuggestions(env).find((s) => s.kind === 'inactivity' && s.job_id === job.id);
  const historyBefore = history(env, job.id).length;
  env.gas.acceptSuggestion(ghost.id);
  assert.equal(jobById(env, job.id).status, 'Ghosted');
  env.gas.undoSuggestion(ghost.id);
  assert.equal(jobById(env, job.id).status, 'Applied');
  assert.equal(history(env, job.id).length, historyBefore, 'the accept history row is removed');
  assert.equal(env.gas.runGhostCheck_(inDays(31)), 0, 'nothing new is created');
  assert.equal(allSuggestions(env).find((s) => s.id === ghost.id).state, 'pending', 'the suggestion survives the next check');
});

test('undoSuggestion works for email suggestions and refuses after a later change', () => {
  const env = synced();
  const job = add(env);
  env.gmail.add({ from: 'jobs@acme.com', subject: 'R-10001', body: 'Unfortunately not this time.' });
  sync(env);
  const s = review(env).suggestions[0];
  env.gas.acceptSuggestion(s.id);
  env.gas.undoSuggestion(s.id);
  assert.equal(jobById(env, job.id).status, 'Applied');
  assert.equal(review(env).suggestions.length, 1);
  env.gas.acceptSuggestion(s.id);
  env.gas.updateJob(job.id, { status: 'Withdrawn' });
  assert.throws(() => env.gas.undoSuggestion(s.id), /CONFLICT: that job was changed after/);
});

test('recently resolved lists accepted and dismissed suggestions, and drops what the app cleaned up itself', () => {
  const env = synced();
  const a = add(env, { requisition_id: 'A-11111' });
  const b = add(env, { requisition_id: 'B-22222', company: 'Globex' });
  env.gmail.add({ from: 'jobs@acme.com', subject: 'A-11111', body: 'Unfortunately not this time.' });
  sync(env);
  const email = review(env).suggestions[0];
  env.gas.acceptSuggestion(email.id);
  env.gas.runGhostCheck_(inDays(31));
  const ghost = allSuggestions(env).find((s) => s.kind === 'inactivity' && s.job_id === b.id);
  env.gas.dismissSuggestion(ghost.id);
  const recent = review(env).recent;
  assert.deepEqual(recent.map((r) => [r.state, r.job.company]).sort(), [['accepted', 'Acme'], ['dismissed', 'Globex']]);
  env.gas.undoSuggestion(email.id);
  assert.equal(review(env).recent.length, 1, 'the undone one is pending again, not recent');
  env.gas.updateJob(a.id, { status: 'Withdrawn' });
  env.gas.acceptSuggestion(email.id);
  env.gas.updateJob(a.id, { status: 'Offer' });
  assert.ok(!review(env).recent.some((r) => r.job.company === 'Acme'), 'not listed once the job changed after the accept');
});
