/**
 * Job Tracker — Phase 2: Gmail sync, matching, classification, inactivity
 * ("ghosted") checks and the Review queue.
 *
 * Gmail access is read-only (gmail.readonly in appsscript.json). For each email
 * only the subject, sender, date and snippet are stored, and only when it becomes
 * a suggestion. Message bodies are read in memory to find requisition IDs and
 * keywords; they are never saved or logged, and nothing logs email content.
 *
 * Nothing here changes a job's status: emails and inactivity only create
 * suggestions, which you accept or dismiss on the Review tab.
 */

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const SHEET_SUGGESTIONS = 'Suggestions';
const SHEET_SETTINGS = 'Settings';
const SHEET_RULES = 'Rules';
const SUGGESTION_COLUMNS = [
  'id', 'job_id', 'kind', 'dedupe_key', 'gmail_message_id', 'suggested_status', 'matched_by',
  'subject', 'sender', 'email_date', 'snippet', 'state', 'created_at', 'resolved_at',
];
const FINAL_STATUSES = ['Rejected', 'Withdrawn'];
const CATEGORY_ORDER = ['offer', 'rejection', 'interview', 'confirmation']; // precedence
const CATEGORY_STATUS = { offer: 'Offer', rejection: 'Rejected', interview: 'Interviewing', confirmation: null };
const TRIGGER_HOURS = [0, 1, 2, 4, 6, 8, 12];
const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_DUE_MS = 15 * 60 * 1000; // opening the app syncs if the last sync is older than this
const INTERACTIVE_BUDGET_MS = 25 * 1000;
const SCHEDULED_BUDGET_MS = 4.5 * 60 * 1000;
const FETCH_PAUSE_MS = 120;          // between email fetches, to stay under Gmail's per-minute limit
const RATE_LIMIT_WAIT_MS = 60 * 1000; // Gmail's limit is per minute

const DEFAULT_SETTINGS = [
  ['gmail_query', '-category:promotions -category:social -in:sent -in:drafts -in:chats',
    'Which emails to check, in Gmail search syntax. Default skips Promotions, Social, and your own sent mail.'],
  ['initial_sync_days', '60', 'How many days back the first sync looks.'],
  ['auto_sync_hours', '1', 'Background sync every N hours: 1, 2, 4, 6, 8 or 12. 0 turns it off.'],
  ['ghost_applied_days', '30', 'Suggest Ghosted when an Applied job has had no activity for more than this many days.'],
  ['ghost_interviewing_days', '21', 'Same, for Interviewing jobs.'],
  ['ats_domains', 'greenhouse.io, lever.co, myworkdayjobs.com, icims.com, smartrecruiters.com, ' +
    'ashbyhq.com, workable.com, linkedin.com, indeed.com',
    'Shared recruiting-system domains (comma-separated). Never used to match a job by email domain.'],
  ['min_requisition_id_length', '5', 'Requisition IDs shorter than this are not searched for in emails.'],
];

// [category, include|exclude, pattern, note]. Patterns are JavaScript regular
// expressions, matched case-insensitively against the subject and body.
const DEFAULT_RULES = [
  ['offer', 'include', '\\boffer letter\\b', ''],
  ['offer', 'include', '\\b(pleased|delighted|happy|excited|thrilled) to (extend|offer)\\b', ''],
  ['offer', 'include', '\\b(verbal|formal|job) offer\\b', ''],
  ['offer', 'include', '\\boffer of employment\\b', ''],
  ['offer', 'exclude', '\\b(unable|not able|not in a position) to (extend|offer|move)\\b', 'turned down'],
  ['rejection', 'include', '\\bunfortunately\\b', ''],
  ['rejection', 'include', '\\bregret to inform\\b', ''],
  ['rejection', 'include', '\\bnot (to )?(be )?mov(e|ing) forward\\b', ''],
  ['rejection', 'include', '\\b(decided|chosen|chose) to (pursue|proceed|move forward) with other\\b', ''],
  ['rejection', 'include', '\\b(other|another) candidates?\\b', ''],
  ['rejection', 'include', '\\bno longer (being )?considered\\b', ''],
  ['rejection', 'include', '\\b(position|role) has been filled\\b', ''],
  ['rejection', 'include', '\\bnot (been )?selected\\b', ''],
  ['rejection', 'include', '\\b(unable|not able|not in a position) to (extend|offer|move)\\b', ''],
  ['rejection', 'exclude', 'reschedul', 'e.g. "unfortunately we need to reschedule your interview"'],
  ['rejection', 'exclude', '\\b(need|have) to (move|change|push back|postpone)\\b', 'moving an interview'],
  ['interview', 'include', '\\binterview', ''],
  ['interview', 'include', '\\bphone screen', ''],
  ['interview', 'include', '\\b(schedule|book|find) (a |some )?time\\b', ''],
  ['interview', 'include', '\\b(online assessment|coding (challenge|assessment)|take[- ]home)\\b', ''],
  ['interview', 'exclude', '\\bif (you are |you\'re )?selected\\b', 'confirmation emails that mention a future interview'],
  ['interview', 'exclude', '\\bif your (qualifications|experience|background|skills|profile)\\b', ''],
  ['interview', 'exclude', '\\b(will|may) (be in touch|contact you|reach out)( to you)? (if|should)\\b', ''],
  ['interview', 'exclude', '\\bwebinar\\b', ''],
  ['confirmation', 'include', '\\bthank you for (applying|your application|your interest)\\b', ''],
  ['confirmation', 'include', '\\bapplication (has been |was )?(received|submitted)\\b', ''],
  ['confirmation', 'include', '\\b(we|we\'ve|we have) received your application\\b', ''],
];

// ---------------------------------------------------------------------------
// Schema v2 (called from MIGRATIONS in Code.gs)
// ---------------------------------------------------------------------------

function migrateV2_(ss) {
  // Jobs: insert last_email_at right after updated_at, so any extra columns the
  // user added further right move over instead of being overwritten.
  const jobs = ss.getSheetByName(SHEET_JOBS);
  const col = JOB_COLUMNS_V1.length;
  jobs.insertColumnAfter(col);
  jobs.getRange(1, col + 1, jobs.getMaxRows(), 1).setNumberFormat('@');
  jobs.getRange(1, col + 1).setValue('last_email_at').setFontWeight('bold');
  protectColumns_(jobs, ['last_email_at'], 'Written by Gmail sync — the latest email matched to this job.');

  const suggestions = createSheet_(ss, SHEET_SUGGESTIONS, SUGGESTION_COLUMNS);
  suggestions.getRange(1, 1, suggestions.getMaxRows(), SUGGESTION_COLUMNS.length).protect()
    .setWarningOnly(true).setDescription('Suggestions are written by the Job Tracker app.');

  const settings = createSheet_(ss, SHEET_SETTINGS, ['setting', 'value', 'description']);
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  }
  const rules = createSheet_(ss, SHEET_RULES, ['category', 'type', 'pattern', 'note']);
  if (rules.getLastRow() < 2) {
    rules.getRange(2, 1, DEFAULT_RULES.length, 4).setValues(DEFAULT_RULES);
  }
}

// ---------------------------------------------------------------------------
// Settings & rules (editable in the Settings and Rules tabs)
// ---------------------------------------------------------------------------

function positiveInt_(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function readSettings_() {
  const values = {};
  DEFAULT_SETTINGS.forEach(function (r) { values[r[0]] = r[1]; });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
      const key = String(r[0]).trim();
      if (key in values && String(r[1]).trim() !== '') values[key] = String(r[1]).trim();
    });
  }
  const hours = Number(values.auto_sync_hours);
  return {
    gmailQuery: values.gmail_query,
    initialDays: positiveInt_(values.initial_sync_days, 60),
    autoSyncHours: TRIGGER_HOURS.indexOf(hours) >= 0 ? hours : 1,
    ghostAppliedDays: positiveInt_(values.ghost_applied_days, 30),
    ghostInterviewingDays: positiveInt_(values.ghost_interviewing_days, 21),
    atsDomains: values.ats_domains.split(/[\s,;]+/).map(normalizeDomain_).filter(Boolean),
    minIdLength: positiveInt_(values.min_requisition_id_length, 5),
  };
}

/** {rules: {category: {include: [RegExp], exclude: [RegExp]}}, problems: [text]} */
function readRules_() {
  const rules = {};
  const problems = [];
  CATEGORY_ORDER.forEach(function (c) { rules[c] = { include: [], exclude: [] }; });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RULES);
  const rows = sheet && sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getDisplayValues()
    : DEFAULT_RULES.map(function (r) { return r.slice(0, 3); });
  rows.forEach(function (r, i) {
    const category = String(r[0]).trim().toLowerCase();
    const type = String(r[1]).trim().toLowerCase();
    const pattern = String(r[2]).trim();
    if (!category && !pattern) return;
    if (!rules[category] || (type !== 'include' && type !== 'exclude') || !pattern) {
      problems.push('Rules row ' + (i + 2) + ' is incomplete (needs category, include/exclude and a pattern)');
      return;
    }
    try {
      rules[category][type].push(new RegExp(pattern, 'i'));
    } catch (e) {
      problems.push('Rules row ' + (i + 2) + ' has an invalid pattern');
    }
  });
  return { rules: rules, problems: problems };
}

// ---------------------------------------------------------------------------
// Classifier & matcher
// ---------------------------------------------------------------------------

/** First category (by precedence) with an include match and no exclude match, or null. */
function classify_(text, rules) {
  for (let i = 0; i < CATEGORY_ORDER.length; i++) {
    const r = rules[CATEGORY_ORDER[i]];
    const included = r.include.some(function (re) { return re.test(text); });
    if (included && !r.exclude.some(function (re) { return re.test(text); })) return CATEGORY_ORDER[i];
  }
  return null;
}

function escapeRegex_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word matcher: not preceded or followed by a letter/digit. */
function wholeWord_(text) {
  return new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRegex_(text.trim()) + '(?=$|[^\\p{L}\\p{N}])', 'iu');
}

function normalizeDomain_(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^.*@/, '').replace(/^www\./, '').replace(/\.$/, '');
}

function isAtsDomain_(domain, atsDomains) {
  return atsDomains.some(function (a) { return domain === a || domain.slice(-(a.length + 1)) === '.' + a; });
}

/** "Jane Doe <jane@acme.com>" -> {name, address, domain}. */
function parseSender_(from) {
  const text = String(from || '').trim();
  const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(text);
  const name = m ? m[1].replace(/^"|"$/g, '').trim() : '';
  const address = (m ? m[2] : text).trim().toLowerCase();
  return { name: name, address: address, domain: normalizeDomain_(address.split('@')[1] || '') };
}

/** Pre-compile per-job matchers once per sync. */
function buildMatcher_(jobs, settings) {
  return jobs.map(function (j) {
    const req = String(j.requisition_id || '').trim();
    const domain = normalizeDomain_(j.email_domain);
    return {
      job: j,
      reqRe: req.length >= settings.minIdLength ? wholeWord_(req) : null,
      domain: domain && !isAtsDomain_(domain, settings.atsDomains) ? domain : null,
      companyRe: j.company ? wholeWord_(j.company) : null,
    };
  });
}

/**
 * Match an email to one job. Rules in order — requisition ID in subject/body,
 * sender domain, company name in sender name/subject — stopping at the first
 * that yields exactly one job. Several matches are narrowed to jobs that aren't
 * Rejected/Withdrawn; if still ambiguous the email is ignored.
 * Returns {job, matchedBy}, {ambiguous: rule} or null.
 */
function matchJob_(email, matcher, settings) {
  const text = email.subject + '\n' + email.body;
  const senderIsAts = isAtsDomain_(email.sender.domain, settings.atsDomains);
  const steps = [
    ['requisition_id', function (m) { return m.reqRe && m.reqRe.test(text); }],
    ['email_domain', function (m) { return m.domain && !senderIsAts && m.domain === email.sender.domain; }],
    ['company', function (m) {
      return m.companyRe && (m.companyRe.test(email.sender.name) || m.companyRe.test(email.subject));
    }],
  ];
  for (let i = 0; i < steps.length; i++) {
    const found = matcher.filter(steps[i][1]).map(function (m) { return m.job; });
    if (found.length === 1) return { job: found[0], matchedBy: steps[i][0] };
    if (found.length > 1) {
      const open = found.filter(function (j) { return FINAL_STATUSES.indexOf(j.status) < 0; });
      if (open.length === 1) return { job: open[0], matchedBy: steps[i][0] };
      return { ambiguous: steps[i][0] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading Gmail messages
// ---------------------------------------------------------------------------

function gmailAvailable_() {
  return typeof Gmail !== 'undefined' && !!Gmail && !!Gmail.Users;
}

function decodeBodyData_(data) {
  try {
    const bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  } catch (e) {
    return '';
  }
}

function decodeEntities_(text) {
  return String(text)
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function stripHtml_(html) {
  return decodeEntities_(String(html)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ');
}

/** Plain text of a message (text/plain preferred), first 20,000 characters. Memory only. */
function extractBody_(payload) {
  let plain = '';
  let html = '';
  (function walk(part) {
    if (!part) return;
    const mime = String(part.mimeType || '').toLowerCase();
    if (part.body && part.body.data && !part.filename) {
      if (mime === 'text/plain') plain += decodeBodyData_(part.body.data) + '\n';
      else if (mime === 'text/html') html += decodeBodyData_(part.body.data) + '\n';
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return (plain || stripHtml_(html)).slice(0, 20000);
}

/** The parts of a Gmail message the matcher needs. */
function readEmail_(message) {
  const headers = {};
  ((message.payload && message.payload.headers) || []).forEach(function (h) {
    headers[String(h.name).toLowerCase()] = h.value;
  });
  const snippet = decodeEntities_(message.snippet || '');
  const body = extractBody_(message.payload);
  return {
    id: message.id,
    subject: String(headers.subject || ''),
    from: String(headers.from || ''),
    sender: parseSender_(headers.from),
    date: new Date(Number(message.internalDate) || Date.now()).toISOString(),
    snippet: snippet,
    body: body || snippet,
  };
}

function isNotFound_(e) {
  return /not ?found|404/i.test(String(e && e.message ? e.message : e));
}

function epochSeconds_(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

/** All message ids for a Gmail search. */
function listMessageIds_(query) {
  const ids = [];
  let pageToken;
  do {
    const resp = Gmail.Users.Messages.list('me', { q: query, maxResults: 500, pageToken: pageToken });
    (resp.messages || []).forEach(function (m) { ids.push(m.id); });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return ids;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function newSyncContext_(settings, rules) {
  const jobs = readJobs_();
  const known = {};
  readSuggestions_().forEach(function (s) { known[s.dedupe_key] = true; });
  // Emails already checked in a batch that was interrupted (time or rate limit).
  const seen = {};
  JSON.parse(PropertiesService.getDocumentProperties().getProperty('gmailCheckedIds') || '[]')
    .forEach(function (id) { seen[id] = true; });
  return {
    settings: settings, rules: rules, matcher: buildMatcher_(jobs, settings), known: known,
    seen: seen, suggestions: [], lastEmail: {}, processed: 0,
  };
}

function isRateLimited_(e) {
  return /quota exceeded|rate ?limit|too many (requests|times)|\b429\b/i.test(String(e && e.message ? e.message : e));
}

/**
 * Fetch and check message ids, pacing requests to stay under Gmail's per-minute
 * limit. If Gmail still says "slow down", wait a minute and retry when the time
 * budget allows, otherwise stop. Returns 'done', 'timeout' or 'rate-limited'.
 */
function processIds_(ids, ctx, deadline) {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (ctx.seen[id] || ctx.known['gmail:' + id]) continue;
    if (Date.now() > deadline) return 'timeout';
    let message = null;
    for (let attempt = 0; !message; attempt++) {
      try {
        message = Gmail.Users.Messages.get('me', id, { format: 'full' });
      } catch (e) {
        if (isNotFound_(e)) break; // deleted since it was listed
        if (!isRateLimited_(e)) throw e;
        if (attempt >= 2 || deadline - Date.now() < RATE_LIMIT_WAIT_MS + 10000) return 'rate-limited';
        Utilities.sleep(RATE_LIMIT_WAIT_MS);
      }
    }
    ctx.seen[id] = true; // only once actually checked
    if (!message) continue;
    ctx.processed += 1;
    considerEmail_(readEmail_(message), ctx);
    Utilities.sleep(FETCH_PAUSE_MS);
  }
  return 'done';
}

/** Remember which ids of an unfinished batch were checked (or forget them when done). */
function saveCheckpoint_(ids, ctx, finished) {
  const props = PropertiesService.getDocumentProperties();
  if (finished) {
    props.deleteProperty('gmailCheckedIds');
    return;
  }
  const checked = ids.filter(function (id) { return ctx.seen[id]; }).slice(-500); // property size limit
  props.setProperty('gmailCheckedIds', JSON.stringify(checked));
}

/** Match, classify and queue a suggestion for one email. */
function considerEmail_(email, ctx) {
  const match = matchJob_(email, ctx.matcher, ctx.settings);
  if (!match || !match.job) return;
  const job = match.job;
  if (!ctx.lastEmail[job.id] || email.date > ctx.lastEmail[job.id]) ctx.lastEmail[job.id] = email.date;
  const category = classify_(email.subject + '\n' + email.body, ctx.rules);
  const status = category ? CATEGORY_STATUS[category] : null;
  if (!status || status === job.status) return; // confirmations and no-change emails create nothing
  const key = 'gmail:' + email.id;
  ctx.known[key] = true;
  ctx.suggestions.push({
    job_id: job.id, kind: 'email', dedupe_key: key, gmail_message_id: email.id,
    suggested_status: status, matched_by: match.matchedBy,
    subject: email.subject.slice(0, 500), sender: email.from.slice(0, 300),
    email_date: email.date, snippet: email.snippet.slice(0, 500),
  });
}

/** Save queued suggestions and last_email_at updates. Returns suggestions written. */
function flushSync_(ctx) {
  const queued = ctx.suggestions;
  const lastEmail = ctx.lastEmail;
  ctx.suggestions = [];
  ctx.lastEmail = {};
  return withLock_(function () {
    const written = appendSuggestions_(queued);
    const sheet = sheet_(SHEET_JOBS);
    readJobs_().forEach(function (j) {
      const latest = lastEmail[j.id];
      if (latest && (!j.last_email_at || latest > j.last_email_at)) {
        sheet.getRange(j._row, colOf_('last_email_at')).setNumberFormat('@').setValue(latest);
      }
    });
    return written;
  });
}

function pause_(result, outcome) {
  result.more = true;
  if (outcome === 'rate-limited') result.rateLimited = true;
}

/**
 * Sync Gmail. First run: backfill the last `initial_sync_days` days. Later runs:
 * new messages since the stored historyId; if that id has expired, search since
 * the last sync instead. Stops at `budgetMs` (or when Gmail's rate limit is hit)
 * and resumes on the next run without re-checking emails it already checked.
 * Returns {processed, newSuggestions, more, rateLimited, usedFallback, error, skipped}.
 */
function syncGmail_(options) {
  const result = { processed: 0, newSuggestions: 0, more: false, usedFallback: false };
  if (!gmailAvailable_()) return Object.assign(result, { skipped: 'gmail-unavailable' });
  // A separate lock from the data lock, so a long sync doesn't block saving jobs.
  const syncLock = LockService.getDocumentLock() || LockService.getUserLock();
  if (!syncLock.tryLock(500)) return Object.assign(result, { skipped: 'already-running' });
  const props = PropertiesService.getDocumentProperties();
  const deadline = Date.now() + options.budgetMs;
  const startedAt = nowIso_();
  try {
    migrate_();
    const settings = readSettings_();
    const rules = readRules_();
    const ctx = newSyncContext_(settings, rules.rules);
    const query = settings.gmailQuery;

    let historyId = props.getProperty('gmailHistoryId');
    if (!historyId) {
      // First sync: remember where Gmail is now, then backfill older mail.
      props.setProperty('gmailBackfillQuery', ('newer_than:' + settings.initialDays + 'd ' + query).trim());
      props.deleteProperty('gmailBackfillPageToken');
      props.setProperty('gmailHistoryId', String(Gmail.Users.getProfile('me').historyId));
    } else {
      const lastSyncAt = props.getProperty('gmailLastSyncAt');
      let ids = [];
      let newHistoryId = historyId;
      try {
        let pageToken;
        do {
          const resp = Gmail.Users.History.list('me', {
            startHistoryId: historyId, historyTypes: ['messageAdded'], maxResults: 500, pageToken: pageToken,
          });
          (resp.history || []).forEach(function (h) {
            (h.messagesAdded || []).forEach(function (a) { ids.push(a.message.id); });
          });
          if (resp.historyId) newHistoryId = String(resp.historyId);
          pageToken = resp.nextPageToken;
        } while (pageToken);
        if (ids.length) {
          // Keep only messages the configured search would return.
          const since = lastSyncAt ? epochSeconds_(lastSyncAt) - DAY_MS / 1000 : null;
          const allowed = {};
          listMessageIds_((since ? 'after:' + since + ' ' : 'newer_than:2d ') + query)
            .forEach(function (id) { allowed[id] = true; });
          ids = ids.filter(function (id) { return allowed[id]; });
        }
      } catch (e) {
        if (!isNotFound_(e)) throw e;
        // History id expired: fall back to a search since the last sync.
        result.usedFallback = true;
        newHistoryId = String(Gmail.Users.getProfile('me').historyId);
        const since = lastSyncAt ? 'after:' + epochSeconds_(lastSyncAt) : 'newer_than:' + settings.initialDays + 'd';
        ids = listMessageIds_((since + ' ' + query).trim());
      }
      const outcome = processIds_(ids, ctx, deadline);
      result.newSuggestions += flushSync_(ctx);
      saveCheckpoint_(ids, ctx, outcome === 'done');
      if (outcome === 'done') props.setProperty('gmailHistoryId', newHistoryId);
      else pause_(result, outcome); // keep the old id; the rest is fetched next time
    }

    // Backfill (first sync), one page at a time so progress survives timeouts.
    let backfillQuery = props.getProperty('gmailBackfillQuery');
    while (backfillQuery && !result.more) {
      const pageToken = props.getProperty('gmailBackfillPageToken') || undefined;
      const resp = Gmail.Users.Messages.list('me', { q: backfillQuery, maxResults: 100, pageToken: pageToken });
      const ids = (resp.messages || []).map(function (m) { return m.id; });
      const outcome = processIds_(ids, ctx, deadline);
      result.newSuggestions += flushSync_(ctx);
      saveCheckpoint_(ids, ctx, outcome === 'done');
      if (outcome !== 'done') {
        pause_(result, outcome);
      } else if (resp.nextPageToken) {
        props.setProperty('gmailBackfillPageToken', resp.nextPageToken);
      } else {
        props.deleteProperty('gmailBackfillQuery');
        props.deleteProperty('gmailBackfillPageToken');
        backfillQuery = null;
      }
    }

    result.processed = ctx.processed;
    props.setProperty('gmailLastSyncAt', startedAt);
    if (rules.problems.length) props.setProperty('gmailLastSyncError', rules.problems.join('; '));
    else props.deleteProperty('gmailLastSyncError');
  } catch (e) {
    if (isRateLimited_(e)) {
      // Not a failure: Gmail asked us to slow down. The next sync carries on.
      pause_(result, 'rate-limited');
    } else {
      // Error messages from Gmail/Sheets don't contain email content.
      result.error = String(e && e.message ? e.message : e).replace(/^(Error|Exception):\s*/, '');
      props.setProperty('gmailLastSyncError', result.error);
      props.setProperty('gmailLastSyncErrorAt', nowIso_());
    }
  } finally {
    syncLock.releaseLock();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Suggestions storage
// ---------------------------------------------------------------------------

function readSuggestions_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEET_SUGGESTIONS)) return [];
  return readTable_(SHEET_SUGGESTIONS, SUGGESTION_COLUMNS).map(function (s) {
    s.id = Number(s.id);
    s.job_id = Number(s.job_id);
    return s;
  });
}

/** Append new pending suggestions, skipping any dedupe_key that already exists. Lock held. */
function appendSuggestions_(items) {
  if (!items.length) return 0;
  const existing = readSuggestions_();
  const keys = {};
  existing.forEach(function (s) { keys[s.dedupe_key] = true; });
  const fresh = items.filter(function (s) {
    if (keys[s.dedupe_key]) return false;
    keys[s.dedupe_key] = true;
    return true;
  });
  if (!fresh.length) return 0;
  const ids = allocateIds_('nextSuggestionId', existing, fresh.length);
  const now = nowIso_();
  appendRows_(SHEET_SUGGESTIONS, SUGGESTION_COLUMNS, fresh.map(function (s, i) {
    return Object.assign({
      gmail_message_id: null, matched_by: null, subject: null, sender: null, email_date: null, snippet: null,
    }, s, { id: ids[i], state: 'pending', created_at: now, resolved_at: null });
  }));
  return fresh.length;
}

function resolveSuggestion_(suggestion, state) {
  suggestion.state = state;
  suggestion.resolved_at = nowIso_();
  const range = sheet_(SHEET_SUGGESTIONS).getRange(suggestion._row, 1, 1, SUGGESTION_COLUMNS.length);
  range.setNumberFormat('@');
  range.setValues([toRow_(suggestion, SUGGESTION_COLUMNS)]);
}

function findPendingSuggestion_(id) {
  const s = readSuggestions_().filter(function (x) { return x.id === Number(id); })[0];
  if (!s) throw new Error(CONFLICT + 'that suggestion no longer exists');
  if (s.state !== 'pending') throw new Error(CONFLICT + 'that suggestion was already ' + s.state);
  return s;
}

// ---------------------------------------------------------------------------
// Inactivity ("ghosted") check
// ---------------------------------------------------------------------------

/** Latest of the job's last status change and its latest matched email. */
function lastActivity_(job, lastChangeByJob) {
  const a = lastChangeByJob[job.id] || null;
  const b = job.last_email_at || null;
  return a && b ? (a > b ? a : b) : a || b;
}

/**
 * Suggest Ghosted for Applied jobs quiet for more than ghost_applied_days and
 * Interviewing jobs quiet for more than ghost_interviewing_days. Deduped on
 * ghost:<job_id>:<last_activity_at>, so a dismissed suggestion only returns after
 * new activity followed by another quiet spell. Pending ghost suggestions made
 * stale by new activity are dismissed. Returns the number created.
 */
function runGhostCheck_(now) {
  const nowMs = (now || new Date()).getTime();
  const settings = readSettings_();
  return withLock_(function () {
    if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUGGESTIONS)) return 0;
    const lastChange = {};
    readHistory_().forEach(function (h) {
      if (!lastChange[h.job_id] || h.changed_at > lastChange[h.job_id]) lastChange[h.job_id] = h.changed_at;
    });
    const suggestions = readSuggestions_();
    const keys = {};
    suggestions.forEach(function (s) { keys[s.dedupe_key] = true; });
    const created = [];
    readJobs_().forEach(function (job) {
      const last = lastActivity_(job, lastChange);
      const limit = job.status === 'Applied' ? settings.ghostAppliedDays
        : job.status === 'Interviewing' ? settings.ghostInterviewingDays : null;
      const key = last ? 'ghost:' + job.id + ':' + last : null;
      suggestions.forEach(function (s) {
        if (s.job_id === job.id && s.kind === 'inactivity' && s.state === 'pending' && (!limit || s.dedupe_key !== key)) {
          resolveSuggestion_(s, 'dismissed');
        }
      });
      if (!limit || !last || keys[key]) return;
      if (nowMs - Date.parse(last) <= limit * DAY_MS) return;
      created.push({ job_id: job.id, kind: 'inactivity', dedupe_key: key, suggested_status: 'Ghosted' });
    });
    return appendSuggestions_(created);
  });
}

// ---------------------------------------------------------------------------
// Background trigger
// ---------------------------------------------------------------------------

/** Make the time-based trigger match auto_sync_hours (0 = no trigger). */
function ensureTrigger_(hours) {
  const props = PropertiesService.getDocumentProperties();
  const existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'scheduledSync';
  });
  if (props.getProperty('autoSyncHours') === String(hours) && existing.length === (hours ? 1 : 0)) return;
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (hours) ScriptApp.newTrigger('scheduledSync').timeBased().everyHours(hours).create();
  props.setProperty('autoSyncHours', String(hours));
}

/** Runs from the time-based trigger. */
function scheduledSync() {
  ensureTrigger_(readSettings_().autoSyncHours);
  syncGmail_({ budgetMs: SCHEDULED_BUDGET_MS });
  runGhostCheck_();
}

// ---------------------------------------------------------------------------
// Client API (Review tab)
// ---------------------------------------------------------------------------

function reviewData_() {
  const props = PropertiesService.getDocumentProperties();
  const jobsById = {};
  readJobs_().forEach(function (j) { jobsById[j.id] = j; });
  const now = Date.now();
  const items = readSuggestions_()
    .filter(function (s) { return s.state === 'pending' && jobsById[s.job_id]; })
    .map(function (s) {
      const job = jobsById[s.job_id];
      const lastActivity = s.kind === 'inactivity' ? s.dedupe_key.split(':').slice(2).join(':') : null;
      return {
        id: s.id, kind: s.kind, suggested_status: s.suggested_status, matched_by: s.matched_by,
        subject: s.subject, sender: s.sender, email_date: s.email_date, snippet: s.snippet,
        created_at: s.created_at,
        inactive_days: lastActivity ? Math.floor((now - Date.parse(lastActivity)) / DAY_MS) : null,
        job: { id: job.id, company: job.company, role: job.role, requisition_id: job.requisition_id, status: job.status },
      };
    })
    .sort(function (a, b) {
      const x = a.email_date || a.created_at;
      const y = b.email_date || b.created_at;
      return x < y ? 1 : x > y ? -1 : b.id - a.id;
    });
  const lastSyncAt = props.getProperty('gmailLastSyncAt');
  const available = gmailAvailable_();
  return {
    suggestions: items,
    gmailAvailable: available,
    lastSyncAt: lastSyncAt,
    lastSyncError: props.getProperty('gmailLastSyncError'),
    backfillInProgress: !!props.getProperty('gmailBackfillQuery'),
    autoSyncHours: available ? readSettings_().autoSyncHours : 0,
    syncDue: available && (!lastSyncAt || now - Date.parse(lastSyncAt) > SYNC_DUE_MS),
  };
}

/** "Sync now" button, and the automatic sync when the app is opened. */
function syncNow() {
  if (gmailAvailable_()) {
    try {
      ensureTrigger_(readSettings_().autoSyncHours);
    } catch (e) {
      // Trigger permission not granted yet: syncing still works.
    }
  }
  const result = syncGmail_({ budgetMs: INTERACTIVE_BUDGET_MS });
  result.newSuggestions += runGhostCheck_();
  return result;
}

/** Accept a suggestion, optionally as a different status ("Accept as"). */
function acceptSuggestion(id, status) {
  return withLock_(function () {
    const s = findPendingSuggestion_(id);
    const newStatus = status || s.suggested_status;
    if (STATUSES.indexOf(newStatus) < 0) throw validationError_(['Unknown status ' + newStatus]);
    // Goes through the one status-change function, recording where it came from.
    changeStatus_(s.job_id, newStatus, s.kind === 'email' ? 'email' : 'inactivity');
    resolveSuggestion_(s, 'accepted');
    return true;
  });
}

/** Put an accepted or dismissed suggestion back in the pending list (the Undo button). */
function reopenSuggestion(id) {
  return withLock_(function () {
    const s = readSuggestions_().filter(function (x) { return x.id === Number(id); })[0];
    if (!s) throw new Error(CONFLICT + 'that suggestion no longer exists');
    if (s.state !== 'pending') {
      s.state = 'pending';
      s.resolved_at = null;
      const range = sheet_(SHEET_SUGGESTIONS).getRange(s._row, 1, 1, SUGGESTION_COLUMNS.length);
      range.setNumberFormat('@');
      range.setValues([toRow_(s, SUGGESTION_COLUMNS)]);
    }
    return true;
  });
}

function dismissSuggestion(id) {
  return withLock_(function () {
    resolveSuggestion_(findPendingSuggestion_(id), 'dismissed');
    return true;
  });
}
