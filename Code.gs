/**
 * @OnlyCurrentDoc
 *
 * Job Tracker — server code (Google Apps Script, bound to the "Job Tracker" sheet).
 *
 * Served as a web app: Deploy → New deployment → Web app,
 * Execute as: Me, Who has access: Only myself.
 *
 * All reading and writing of the sheets lives in this file. Values are stored as
 * plain text: dates as YYYY-MM-DD, timestamps as UTC ISO-8601.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUSES = ['Applied', 'Interviewing', 'Offer', 'Rejected', 'Ghosted', 'Withdrawn'];
const FOLLOW_UP_EXCLUDED = ['Rejected', 'Withdrawn', 'Offer'];
const HISTORY_SOURCES = ['manual', 'email', 'import', 'inactivity'];

const REQUIRED_FIELDS = ['requisition_id', 'company', 'role'];
const DATE_FIELDS = ['date_applied', 'follow_up'];
const JOB_FIELDS = [
  'requisition_id', 'company', 'role', 'date_applied', 'status', 'location',
  'salary_range', 'job_url', 'contact', 'email_domain', 'follow_up', 'notes',
];
const JOB_COLUMNS = ['id'].concat(JOB_FIELDS, ['created_at', 'updated_at']);
const HISTORY_COLUMNS = ['id', 'job_id', 'old_status', 'new_status', 'changed_at', 'source'];

const FIELD_LABELS = {
  requisition_id: 'Requisition ID',
  company: 'Company',
  role: 'Role',
  date_applied: 'Date applied',
  status: 'Status',
  location: 'Location',
  salary_range: 'Salary range',
  job_url: 'Job URL',
  contact: 'Contact',
  email_domain: 'Email domain',
  follow_up: 'Follow-up',
  notes: 'Notes',
};

const SHEET_JOBS = 'Jobs';
const SHEET_HISTORY = 'StatusHistory';
const CONFLICT = 'CONFLICT: ';

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

function doGet() {
  migrate_();
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Job Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Used by Index.html to inline Stylesheet.html and JavaScript.html. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Run once from the editor to create the sheets and grant permissions. */
function setup() {
  migrate_();
}

// ---------------------------------------------------------------------------
// Schema & migrations (version kept in document properties)
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  function v1(ss) {
    const jobs = createSheet_(ss, SHEET_JOBS, JOB_COLUMNS);
    applyStatusValidation_(jobs, 2, jobs.getMaxRows() - 1);
    protectColumns_(jobs, ['id', 'created_at', 'updated_at'],
      'Managed by the Job Tracker app — editing these can break it.');
    const history = createSheet_(ss, SHEET_HISTORY, HISTORY_COLUMNS);
    history.getRange(1, 1, history.getMaxRows(), HISTORY_COLUMNS.length).protect()
      .setWarningOnly(true).setDescription('Status history is written by the Job Tracker app.');
  },
];

function migrate_() {
  const props = PropertiesService.getDocumentProperties();
  const version = Number(props.getProperty('schemaVersion') || 0);
  if (version > MIGRATIONS.length) {
    throw new Error('This sheet was set up by a newer version of the Job Tracker. Update Code.gs.');
  }
  if (version === MIGRATIONS.length) return;
  withLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // Re-read inside the lock: another execution may have migrated already.
    let v = Number(props.getProperty('schemaVersion') || 0);
    while (v < MIGRATIONS.length) {
      MIGRATIONS[v](ss);
      v += 1;
      props.setProperty('schemaVersion', String(v));
    }
  });
}

function createSheet_(ss, name, columns) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.getRange(1, 1, sheet.getMaxRows(), columns.length).setNumberFormat('@');
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

function applyStatusValidation_(sheet, firstRow, numRows) {
  if (numRows < 1) return;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(firstRow, colOf_('status'), numRows, 1).setDataValidation(rule);
}

function protectColumns_(sheet, columns, description) {
  columns.forEach(function (name) {
    sheet.getRange(1, colOf_(name), sheet.getMaxRows(), 1).protect()
      .setWarningOnly(true).setDescription(description);
  });
}

// ---------------------------------------------------------------------------
// Low-level sheet access
// ---------------------------------------------------------------------------

function sheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet "' + name + '". Open the web app once to set it up.');
  return sheet;
}

function colOf_(name) {
  return JOB_COLUMNS.indexOf(name) + 1;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Rows of a sheet as objects (blank cells -> null). `_row` is the sheet row. */
function readTable_(name, columns) {
  const sheet = sheet_(name);
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];
  return sheet.getRange(2, 1, count, columns.length).getDisplayValues()
    .map(function (values, i) {
      const record = { _row: i + 2 };
      columns.forEach(function (c, j) {
        const v = String(values[j]).trim();
        record[c] = v === '' ? null : v;
      });
      return record;
    })
    .filter(function (r) { return r.id !== null; });
}

function readJobs_() {
  return readTable_(SHEET_JOBS, JOB_COLUMNS).map(function (j) {
    j.id = Number(j.id);
    return j;
  });
}

function readHistory_() {
  return readTable_(SHEET_HISTORY, HISTORY_COLUMNS).map(function (h) {
    h.id = Number(h.id);
    h.job_id = Number(h.job_id);
    return h;
  });
}

function toRow_(record, columns) {
  return columns.map(function (c) {
    return record[c] === null || record[c] === undefined ? '' : String(record[c]);
  });
}

/** Append records after the last row, growing the sheet if needed. Returns first row. */
function appendRows_(name, columns, records) {
  const sheet = sheet_(name);
  const first = sheet.getLastRow() + 1;
  const needed = first + records.length - 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
  const range = sheet.getRange(first, 1, records.length, columns.length);
  range.setNumberFormat('@'); // before values, so nothing is parsed as a date/formula
  range.setValues(records.map(function (r) { return toRow_(r, columns); }));
  if (name === SHEET_JOBS) applyStatusValidation_(sheet, first, records.length);
  return first;
}

function writeJobRow_(job) {
  const range = sheet_(SHEET_JOBS).getRange(job._row, 1, 1, JOB_COLUMNS.length);
  range.setNumberFormat('@');
  range.setValues([toRow_(job, JOB_COLUMNS)]);
}

function clearRows_(name, firstRow, numRows, numColumns) {
  if (numRows > 0) sheet_(name).getRange(firstRow, 1, numRows, numColumns).clearContent();
}

/** Allocate `count` consecutive ids from a counter in document properties. */
function allocateIds_(key, existing, count) {
  const props = PropertiesService.getDocumentProperties();
  let next = Number(props.getProperty(key) || 0);
  const maxExisting = existing.reduce(function (m, r) { return Math.max(m, r.id); }, 0);
  next = Math.max(next, maxExisting + 1);
  props.setProperty(key, String(next + count));
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(next + i);
  return ids;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function nowIso_() {
  return new Date().toISOString();
}

/** A timestamp strictly after `previous` (updated_at doubles as a version). */
function nextTimestamp_(previous) {
  const now = nowIso_();
  if (!previous || now > previous) return now;
  return new Date(new Date(previous).getTime() + 1).toISOString();
}

function isIsoDate_(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return !!m && isRealDate_(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isRealDate_(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isoFromParts_(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isBlank_(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * Trim/check the job fields present in `data`. Returns {clean, problems}.
 * Unknown keys are ignored; blanks become null; required fields that are present
 * must be non-blank; dates must be YYYY-MM-DD; status must be known.
 */
function normalizeFields_(data) {
  const clean = {};
  const problems = [];
  JOB_FIELDS.forEach(function (f) {
    if (!(f in data)) return;
    const v = isBlank_(data[f]) ? null : String(data[f]).trim();
    if (v !== null && DATE_FIELDS.indexOf(f) >= 0 && !isIsoDate_(v)) {
      problems.push(FIELD_LABELS[f] + ' must be a valid date (got "' + v + '")');
    }
    clean[f] = v;
  });
  REQUIRED_FIELDS.forEach(function (f) {
    if (f in clean && clean[f] === null) problems.push(FIELD_LABELS[f] + ' is required');
  });
  if ('status' in clean) {
    if (clean.status === null) problems.push('Status is required');
    else if (STATUSES.indexOf(clean.status) < 0) {
      problems.push('Status must be one of ' + STATUSES.join(', ') + ' (got "' + clean.status + '")');
    }
  }
  return { clean: clean, problems: problems };
}

function validationError_(problems) {
  return new Error('Please fix: ' + problems.join('; '));
}

/** Duplicate key: company + requisition ID, trimmed and case-insensitive. */
function dupKey_(company, requisitionId) {
  return String(company || '').trim().toLowerCase() + '\u0000' +
    String(requisitionId || '').trim().toLowerCase();
}

function publicJob_(job) {
  const out = {};
  JOB_COLUMNS.forEach(function (c) { out[c] = job[c] === undefined ? null : job[c]; });
  return out;
}

// ---------------------------------------------------------------------------
// Jobs (internal functions assume the caller holds the lock)
// ---------------------------------------------------------------------------

/** Validate and fill defaults for a new job. Returns the clean job (no id). */
function prepareNewJob_(data) {
  const input = Object.assign({}, data);
  REQUIRED_FIELDS.forEach(function (f) { if (!(f in input)) input[f] = null; });
  if (isBlank_(input.status)) input.status = 'Applied';
  const result = normalizeFields_(input);
  if (result.problems.length) throw validationError_(result.problems);
  JOB_FIELDS.forEach(function (f) { if (!(f in result.clean)) result.clean[f] = null; });
  return result.clean;
}

/**
 * Insert jobs plus their initial history rows (old_status empty). If writing
 * history fails, the new job rows are removed again.
 */
function insertJobs_(cleanJobs, source) {
  if (HISTORY_SOURCES.indexOf(source) < 0) throw new Error('Unknown history source ' + source);
  if (!cleanJobs.length) return [];
  const now = nowIso_();
  const ids = allocateIds_('nextJobId', readJobs_(), cleanJobs.length);
  const jobs = cleanJobs.map(function (j, i) {
    return Object.assign({ id: ids[i] }, j, { created_at: now, updated_at: now });
  });
  const historyIds = allocateIds_('nextHistoryId', readHistory_(), jobs.length);
  const history = jobs.map(function (j, i) {
    return {
      id: historyIds[i], job_id: j.id, old_status: null, new_status: j.status,
      changed_at: now, source: source,
    };
  });
  const firstRow = appendRows_(SHEET_JOBS, JOB_COLUMNS, jobs);
  try {
    appendRows_(SHEET_HISTORY, HISTORY_COLUMNS, history);
  } catch (e) {
    clearRows_(SHEET_JOBS, firstRow, jobs.length, JOB_COLUMNS.length);
    throw e;
  }
  return jobs.map(function (j, i) { return Object.assign({ _row: firstRow + i }, j); });
}

function findJob_(jobs, id) {
  const job = jobs.filter(function (j) { return j.id === Number(id); })[0];
  if (!job) throw new Error(CONFLICT + 'that job no longer exists');
  return job;
}

/**
 * The single path for changing a job, including its status. A status change
 * writes the job and a status_history row together; if the history write fails
 * the job row is restored. Throws CONFLICT if `expectedUpdatedAt` is stale.
 */
function updateJob_(id, changes, expectedUpdatedAt, source) {
  if (HISTORY_SOURCES.indexOf(source) < 0) throw new Error('Unknown history source ' + source);
  const result = normalizeFields_(changes);
  if (result.problems.length) throw validationError_(result.problems);
  const clean = result.clean;
  const newStatus = clean.status;
  delete clean.status;

  const job = findJob_(readJobs_(), id);
  if (expectedUpdatedAt && job.updated_at !== expectedUpdatedAt) {
    throw new Error(CONFLICT + job.company + ' — ' + job.role + ' was changed elsewhere');
  }
  const before = Object.assign({}, job);
  let fieldsChanged = false;
  Object.keys(clean).forEach(function (f) {
    if (job[f] !== clean[f]) {
      job[f] = clean[f];
      fieldsChanged = true;
    }
  });
  const statusChanged = !!newStatus && newStatus !== job.status;
  if (!fieldsChanged && !statusChanged) return publicJob_(job);

  job.updated_at = nextTimestamp_(job.updated_at);
  let history = null;
  if (statusChanged) {
    history = {
      id: allocateIds_('nextHistoryId', readHistory_(), 1)[0],
      job_id: job.id, old_status: job.status, new_status: newStatus,
      changed_at: job.updated_at, source: source,
    };
    job.status = newStatus;
  }
  writeJobRow_(job);
  if (history) {
    try {
      appendRows_(SHEET_HISTORY, HISTORY_COLUMNS, [history]);
    } catch (e) {
      writeJobRow_(before);
      throw e;
    }
  }
  return publicJob_(job);
}

/** Status change used by email/inactivity suggestions (Phase 2). */
function changeStatus_(id, newStatus, source, expectedUpdatedAt) {
  return updateJob_(id, { status: newStatus }, expectedUpdatedAt, source);
}

function sortJobs_(jobs) {
  return jobs.slice().sort(function (a, b) {
    if (!a.date_applied !== !b.date_applied) return a.date_applied ? -1 : 1;
    if (a.date_applied !== b.date_applied) return a.date_applied < b.date_applied ? 1 : -1;
    return b.id - a.id;
  });
}

function followUpsDue_(jobs, today) {
  return jobs
    .filter(function (j) {
      return j.follow_up && j.follow_up <= today && FOLLOW_UP_EXCLUDED.indexOf(j.status) < 0;
    })
    .sort(function (a, b) {
      return a.follow_up < b.follow_up ? -1 : a.follow_up > b.follow_up ? 1 : a.id - b.id;
    });
}

function countByStatus_(jobs) {
  const counts = {};
  STATUSES.forEach(function (s) { counts[s] = 0; });
  jobs.forEach(function (j) { if (j.status in counts) counts[j.status] += 1; });
  return counts;
}

/** [{week: 'YYYY-MM-DD' (Monday), count}] from first to last week, gaps filled with 0. */
function applicationsPerWeek_(jobs) {
  const counts = {};
  jobs.forEach(function (j) {
    if (!j.date_applied || !isIsoDate_(j.date_applied)) return;
    const week = mondayOf_(j.date_applied);
    counts[week] = (counts[week] || 0) + 1;
  });
  const weeks = Object.keys(counts).sort();
  if (!weeks.length) return [];
  const out = [];
  const end = new Date(weeks[weeks.length - 1] + 'T00:00:00Z');
  for (let d = new Date(weeks[0] + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    const key = d.toISOString().slice(0, 10);
    out.push({ week: key, count: counts[key] || 0 });
  }
  return out;
}

function mondayOf_(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function today_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// Client API (called from JavaScript.html via google.script.run)
// ---------------------------------------------------------------------------

function getAppData() {
  migrate_();
  const jobs = sortJobs_(readJobs_());
  const today = today_();
  return {
    jobs: jobs.map(publicJob_),
    followUpIds: followUpsDue_(jobs, today).map(function (j) { return j.id; }),
    counts: countByStatus_(jobs),
    perWeek: applicationsPerWeek_(jobs),
    today: today,
    statuses: STATUSES,
    labels: FIELD_LABELS,
    fields: JOB_FIELDS,
    requiredFields: REQUIRED_FIELDS,
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  };
}

/**
 * Add a job. If a job with the same company + requisition ID exists and `force`
 * is false, nothing is saved and {duplicates} is returned so the UI can warn.
 */
function addJob(data, force) {
  return withLock_(function () {
    const clean = prepareNewJob_(data);
    const key = dupKey_(clean.company, clean.requisition_id);
    const duplicates = readJobs_().filter(function (j) {
      return dupKey_(j.company, j.requisition_id) === key;
    });
    if (duplicates.length && !force) return { duplicates: duplicates.map(publicJob_) };
    return { job: publicJob_(insertJobs_([clean], 'manual')[0]) };
  });
}

function updateJob(id, changes, expectedUpdatedAt) {
  return withLock_(function () {
    return updateJob_(id, changes, expectedUpdatedAt, 'manual');
  });
}

/** Delete a job and its status history. */
function deleteJob(id) {
  return withLock_(function () {
    const job = findJob_(readJobs_(), id);
    sheet_(SHEET_JOBS).deleteRow(job._row);
    const history = readHistory_();
    const keep = history.filter(function (h) { return h.job_id !== job.id; });
    if (keep.length !== history.length) {
      clearRows_(SHEET_HISTORY, 2, history.length, HISTORY_COLUMNS.length);
      if (keep.length) {
        sheet_(SHEET_HISTORY).getRange(2, 1, keep.length, HISTORY_COLUMNS.length)
          .setValues(keep.map(function (h) { return toRow_(h, HISTORY_COLUMNS); }));
      }
    }
    return true;
  });
}

function getHistory(id) {
  return readHistory_()
    .filter(function (h) { return h.job_id === Number(id); })
    .sort(function (a, b) {
      return a.changed_at < b.changed_at ? -1 : a.changed_at > b.changed_at ? 1 : a.id - b.id;
    })
    .map(function (h) {
      return { old_status: h.old_status, new_status: h.new_status, changed_at: h.changed_at, source: h.source };
    });
}

/** CSV of the given jobs (in the given order), for "Export current view". */
function exportCsv(ids) {
  const byId = {};
  readJobs_().forEach(function (j) { byId[j.id] = j; });
  const rows = [JOB_COLUMNS].concat(
    ids.filter(function (id) { return byId[id]; }).map(function (id) {
      return toRow_(byId[id], JOB_COLUMNS);
    })
  );
  return rows.map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n') + '\r\n';
}

function csvCell_(value) {
  let v = String(value);
  // Stop spreadsheet apps from treating cell text as a formula.
  if (/^[=+\-@]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

// Normalized header names that auto-map to each field. The first entry is the
// field's own name and wins over other fields' aliases.
const FIELD_ALIASES = {
  requisition_id: ['requisitionid', 'requisition', 'requisitionnumber', 'requisitionno', 'reqid',
    'req', 'reqno', 'reqnumber', 'jobid', 'jobreqid', 'jobrequisitionid', 'postingid'],
  company: ['company', 'companyname', 'employer', 'organization', 'organisation'],
  role: ['role', 'title', 'jobtitle', 'position', 'positiontitle', 'jobrole'],
  date_applied: ['dateapplied', 'applied', 'appliedon', 'applieddate', 'applicationdate',
    'dateofapplication'],
  status: ['status', 'stage', 'applicationstatus'],
  location: ['location', 'city', 'joblocation'],
  salary_range: ['salaryrange', 'salary', 'compensation', 'pay', 'payrange'],
  job_url: ['joburl', 'url', 'link', 'joblink', 'postingurl', 'postinglink'],
  contact: ['contact', 'recruiter', 'contactname', 'hiringmanager'],
  email_domain: ['emaildomain', 'domain'],
  follow_up: ['followup', 'followupdate', 'nextfollowup', 'followupon'],
  notes: ['notes', 'note', 'comments', 'comment'],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];

/** Lowercase and drop spaces/punctuation: "Req. #" -> "req". */
function normalizeHeader_(header) {
  return String(header).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** {field: header or null}. Each header is used once; exact field names beat aliases. */
function suggestMapping_(headers) {
  const mapping = {};
  const used = {};
  JOB_FIELDS.forEach(function (f) { mapping[f] = null; });
  function claim(field, alias) {
    for (let i = 0; i < headers.length; i++) {
      if (!used[i] && normalizeHeader_(headers[i]) === alias) {
        mapping[field] = headers[i];
        used[i] = true;
        return true;
      }
    }
    return false;
  }
  JOB_FIELDS.forEach(function (f) { claim(f, FIELD_ALIASES[f][0]); });
  JOB_FIELDS.forEach(function (f) {
    if (mapping[f] !== null) return;
    FIELD_ALIASES[f].slice(1).some(function (alias) { return claim(f, alias); });
  });
  return mapping;
}

function monthIndex_(token) {
  const t = token.toLowerCase();
  if (t.length < 3) return -1;
  for (let i = 0; i < 12; i++) {
    if (MONTH_NAMES[i].indexOf(t) === 0 || (t === 'sept' && i === 8)) return i + 1;
  }
  return -1;
}

function twoDigitYear_(y) {
  return y < 69 ? 2000 + y : 1900 + y;
}

/**
 * Parse a date in a common format, US order (03/04/2026 = March 4).
 * Returns {iso, ok}: blank -> {iso: null, ok: true}; unparseable -> {iso: null, ok: false}.
 */
function parseDate_(value) {
  let text = isBlank_(value) ? '' : String(value).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { iso: null, ok: true };
  const time = /^(.+?)[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([AaPp][Mm])?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (time) text = time[1];
  let y, m, d, match;
  if ((match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text))) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(text))) {
    m = +match[1]; d = +match[2];
    y = match[3].length === 2 ? twoDigitYear_(+match[3]) : +match[3];
  } else if ((match = /^(\d{4})(\d{2})(\d{2})$/.exec(text))) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else {
    const parts = text.replace(/-/g, ' ').split(' ');
    if (parts.length === 3) {
      if (monthIndex_(parts[0]) > 0 && /^\d{1,2}$/.test(parts[1])) {
        m = monthIndex_(parts[0]); d = +parts[1]; y = parts[2];
      } else if (/^\d{1,2}$/.test(parts[0]) && monthIndex_(parts[1]) > 0) {
        d = +parts[0]; m = monthIndex_(parts[1]); y = parts[2];
      }
      if (y !== undefined) {
        if (/^\d{4}$/.test(y)) y = +y;
        else if (/^\d{2}$/.test(y)) y = twoDigitYear_(+y);
        else y = undefined;
      }
    }
  }
  if (y === undefined || !isRealDate_(y, m, d)) return { iso: null, ok: false };
  return { iso: isoFromParts_(y, m, d), ok: true };
}

/** Canonical status (case-insensitive); blank -> Applied; unknown -> null. */
function parseStatus_(value) {
  if (isBlank_(value)) return 'Applied';
  const t = String(value).trim().toLowerCase();
  for (let i = 0; i < STATUSES.length; i++) {
    if (STATUSES[i].toLowerCase() === t) return STATUSES[i];
  }
  return null;
}

/** RFC 4180 CSV parser (quoted fields, embedded commas/quotes/newlines). */
function parseCsv_(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Turn a raw import record into a clean one. Returns {clean, problems, fields}:
 * clean is null when there are problems; fields lists the fields with problems.
 */
function validateRecord_(raw) {
  const problems = [];
  const fields = [];
  const clean = { _row: raw._row };
  function problem(field, text) {
    problems.push(text);
    if (fields.indexOf(field) < 0) fields.push(field);
  }
  JOB_FIELDS.forEach(function (f) {
    const value = isBlank_(raw[f]) ? '' : String(raw[f]).trim();
    if (REQUIRED_FIELDS.indexOf(f) >= 0 && !value) problem(f, 'missing ' + FIELD_LABELS[f]);
    if (DATE_FIELDS.indexOf(f) >= 0) {
      const parsed = parseDate_(value);
      if (!parsed.ok) problem(f, 'unrecognized ' + FIELD_LABELS[f] + ' "' + value + '"');
      clean[f] = parsed.iso;
    } else if (f === 'status') {
      const status = parseStatus_(value);
      if (status === null) problem(f, 'unknown status "' + value + '"');
      clean[f] = status;
    } else {
      clean[f] = value || null;
    }
  });
  return { clean: problems.length ? null : clean, problems: problems, fields: fields };
}

/** Split raw records into ready / invalid / duplicates (first occurrence wins). */
function buildPlan_(rawRecords, existingKeys) {
  const plan = { ready: [], invalid: [], duplicates: [] };
  const firstSeen = {};
  rawRecords.forEach(function (raw) {
    const result = validateRecord_(raw);
    if (!result.clean) {
      plan.invalid.push({ raw: raw, problems: result.problems, fields: result.fields });
      return;
    }
    const clean = result.clean;
    const key = dupKey_(clean.company, clean.requisition_id);
    if (existingKeys[key]) {
      plan.duplicates.push({ record: clean, reason: 'already in tracker' });
    } else if (firstSeen[key]) {
      plan.duplicates.push({ record: clean, reason: 'duplicate of row ' + firstSeen[key] + ' in this file' });
    } else {
      firstSeen[key] = clean._row;
      plan.ready.push(clean);
    }
  });
  return plan;
}

function existingKeys_() {
  const keys = {};
  readJobs_().forEach(function (j) { keys[dupKey_(j.company, j.requisition_id)] = true; });
  return keys;
}

/**
 * Step 1 of import: parse the file. Returns headers, rows ({_row, values}) and the
 * suggested mapping. `_row` is the spreadsheet row number (header = row 1).
 */
function parseImportFile(csvText) {
  const table = parseCsv_(csvText);
  if (!table.length) throw new Error('That file is empty.');
  const headers = table[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  for (let i = 1; i < table.length; i++) {
    const values = table[i];
    if (values.every(function (v) { return String(v).trim() === ''; })) continue;
    rows.push({ _row: i + 1, values: headers.map(function (_, j) { return values[j] || ''; }) });
  }
  return { headers: headers, rows: rows, mapping: suggestMapping_(headers) };
}

/** Step 2: per-row problems and the plan for the given raw records. */
function checkImport(rawRecords) {
  migrate_();
  return buildPlan_(rawRecords, existingKeys_());
}

/**
 * Step 3: import validated records with history source 'import'. Duplicates are
 * re-checked under the lock and skipped. All-or-nothing on validation errors.
 */
function importJobs(records) {
  return withLock_(function () {
    const plan = buildPlan_(records, existingKeys_());
    if (plan.invalid.length) {
      throw validationError_(plan.invalid.map(function (i) {
        return 'row ' + i.raw._row + ': ' + i.problems.join(', ');
      }));
    }
    const clean = plan.ready.map(function (r) {
      const job = {};
      JOB_FIELDS.forEach(function (f) { job[f] = r[f]; });
      return prepareNewJob_(job);
    });
    const inserted = insertJobs_(clean, 'import');
    return {
      inserted: inserted.length,
      skipped: plan.duplicates.map(function (d) {
        return { _row: d.record._row, company: d.record.company,
          requisition_id: d.record.requisition_id, reason: d.reason };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Direct edits in the sheet
// ---------------------------------------------------------------------------

/**
 * Simple trigger: keeps the Jobs sheet consistent when edited by hand.
 * Single-cell Status edits are recorded in StatusHistory; dates typed in common
 * formats are converted to YYYY-MM-DD; updated_at is bumped for edited rows.
 */
function onEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== SHEET_JOBS || range.getRow() < 2) return;
  const firstCol = range.getColumn();
  const lastCol = firstCol + range.getNumColumns() - 1;
  const single = range.getNumRows() === 1 && range.getNumColumns() === 1;
  const statusCol = colOf_('status');
  const updatedCol = colOf_('updated_at');
  if (firstCol === updatedCol && lastCol === updatedCol) return;

  withLock_(function () {
    if (single && DATE_FIELDS.indexOf(JOB_COLUMNS[firstCol - 1]) >= 0 && !isBlank_(e.value)) {
      const parsed = parseDate_(e.value);
      if (parsed.ok && parsed.iso !== e.value) range.setNumberFormat('@').setValue(parsed.iso);
      if (!parsed.ok) e.source.toast('Use a date like 03/04/2026 or 2026-03-04.', 'Unrecognized date');
    }
    if (single && firstCol === statusCol) {
      const oldStatus = isBlank_(e.oldValue) ? null : String(e.oldValue);
      const newStatus = isBlank_(e.value) ? null : String(e.value).trim();
      if (newStatus === null || STATUSES.indexOf(newStatus) < 0) {
        range.setValue(oldStatus || 'Applied');
        e.source.toast('Status must be one of: ' + STATUSES.join(', '), 'Status not changed');
        return;
      }
      const jobId = Number(sheet.getRange(range.getRow(), colOf_('id')).getDisplayValue());
      if (jobId && newStatus !== oldStatus) {
        appendRows_(SHEET_HISTORY, HISTORY_COLUMNS, [{
          id: allocateIds_('nextHistoryId', readHistory_(), 1)[0],
          job_id: jobId, old_status: oldStatus, new_status: newStatus,
          changed_at: nowIso_(), source: 'manual',
        }]);
      }
    } else if (firstCol <= statusCol && statusCol <= lastCol) {
      e.source.toast('Change statuses one cell at a time (or in the app) so they are recorded in history.',
        'Status history');
    }
    // Rows without an id were typed in by hand; the app ignores them.
    for (let r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) {
      if (isBlank_(sheet.getRange(r, colOf_('id')).getDisplayValue())) continue;
      const cell = sheet.getRange(r, updatedCol);
      cell.setNumberFormat('@').setValue(nextTimestamp_(cell.getDisplayValue()));
    }
  });
}
