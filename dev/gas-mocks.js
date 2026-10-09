/*
 * In-memory stand-ins for the Apps Script services Code.gs uses
 * (SpreadsheetApp, LockService, PropertiesService, Utilities, HtmlService).
 * Used by the Node tests and the browser preview. Not part of the Apps Script project.
 *
 * Behaves like Sheets where it matters to Code.gs: ranges outside the sheet throw,
 * values are stored and returned as text, deleteRow shifts rows up.
 */
(function (root) {
  'use strict';

  function createGasMocks(options) {
    options = options || {};
    const timeZone = options.timeZone || 'America/New_York';

    class Range {
      constructor(sheet, row, col, numRows, numCols) {
        if (row < 1 || col < 1 || numRows < 1 || numCols < 1 ||
            row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxCols) {
          throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
        }
        Object.assign(this, { sheet, row, col, numRows, numCols });
      }
      getSheet() { return this.sheet; }
      getRow() { return this.row; }
      getColumn() { return this.col; }
      getNumRows() { return this.numRows; }
      getNumColumns() { return this.numCols; }
      getDisplayValues() {
        const out = [];
        for (let r = 0; r < this.numRows; r++) {
          const row = [];
          for (let c = 0; c < this.numCols; c++) row.push(this.sheet.cell(this.row + r, this.col + c));
          out.push(row);
        }
        return out;
      }
      getValues() { return this.getDisplayValues(); }
      getDisplayValue() { return this.getDisplayValues()[0][0]; }
      setValues(values) {
        if (this.sheet.failNextWrite) {
          this.sheet.failNextWrite = false;
          throw new Error('Simulated write failure');
        }
        if (values.length !== this.numRows || values.some((v) => v.length !== this.numCols)) {
          throw new Error('The number of rows or columns in the data does not match the range.');
        }
        values.forEach((v, r) => v.forEach((x, c) => this.sheet.setCell(this.row + r, this.col + c, x)));
        return this;
      }
      setValue(value) { return this.setValues([[value]]); }
      clearContent() {
        for (let r = 0; r < this.numRows; r++) {
          for (let c = 0; c < this.numCols; c++) this.sheet.setCell(this.row + r, this.col + c, '');
        }
        return this;
      }
      setNumberFormat() { return this; }
      setFontWeight() { return this; }
      setDataValidation(rule) { this.sheet.validations.push({ row: this.row, numRows: this.numRows, col: this.col, rule }); return this; }
      protect() {
        const p = { setWarningOnly() { return p; }, setDescription() { return p; } };
        return p;
      }
    }

    class Sheet {
      constructor(name) {
        this.name = name;
        this.rows = [];
        this.maxRows = 1000;
        this.maxCols = 26;
        this.validations = [];
        this.failNextWrite = false;
      }
      getName() { return this.name; }
      getMaxRows() { return this.maxRows; }
      getLastRow() {
        for (let r = this.rows.length; r >= 1; r--) {
          if ((this.rows[r - 1] || []).some((v) => v !== '' && v !== undefined)) return r;
        }
        return 0;
      }
      cell(r, c) {
        const v = (this.rows[r - 1] || [])[c - 1];
        return v === undefined || v === null ? '' : String(v);
      }
      setCell(r, c, v) {
        while (this.rows.length < r) this.rows.push([]);
        this.rows[r - 1][c - 1] = v === null || v === undefined ? '' : String(v);
      }
      getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows || 1, numCols || 1); }
      insertRowsAfter(after, howMany) {
        this.rows.splice(after, 0, ...Array.from({ length: howMany }, () => []));
        this.maxRows += howMany;
        return this;
      }
      deleteRow(row) {
        if (row < 1 || row > this.maxRows) throw new Error('Row out of range');
        this.rows.splice(row - 1, 1);
        this.maxRows -= 1;
        return this;
      }
      insertColumnAfter(col) {
        this.rows.forEach((r) => { if (r.length > col) r.splice(col, 0, ''); });
        this.maxCols += 1;
        return this;
      }
      setFrozenRows() { return this; }
      /** Test helper: rows 2.. as arrays of strings, blank rows dropped. */
      dump() {
        return this.rows.slice(1).filter((r) => r.some((v) => v)).map((r) => r.map((v) => v || ''));
      }
    }

    class Spreadsheet {
      constructor() {
        this.sheets = [new Sheet('Sheet1')];
        this.toasts = [];
      }
      getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
      insertSheet(name) {
        if (this.getSheetByName(name)) throw new Error('A sheet with the name "' + name + '" already exists.');
        const s = new Sheet(name);
        this.sheets.push(s);
        return s;
      }
      getSpreadsheetTimeZone() { return timeZone; }
      getUrl() { return 'https://docs.google.com/spreadsheets/d/MOCK/edit'; }
      toast(message, title) { this.toasts.push({ message, title }); }
    }

    const ss = new Spreadsheet();
    const store = {};
    const mocksState = { slept: 0 };
    const lock = { held: 0, waitLock() { this.held += 1; }, releaseLock() { this.held -= 1; } };
    const docLock = {
      held: 0,
      tryLock() { if (this.held) return false; this.held += 1; return true; },
      releaseLock() { this.held -= 1; },
    };

    const triggers = [];
    const ScriptApp = {
      triggers,
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger(t) { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger(handler) {
        const spec = { handler };
        const b = {
          timeBased() { return b; },
          everyHours(h) { spec.hours = h; return b; },
          create() {
            const t = { spec, getHandlerFunction: () => handler };
            triggers.push(t);
            return t;
          },
        };
        return b;
      },
    };

    const gmail = options.gmail === false ? null : new FakeGmail();

    const globals = {
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ss,
        newDataValidation() {
          const rule = {};
          const b = {
            requireValueInList(list, dropdown) { rule.list = list; rule.dropdown = dropdown; return b; },
            setAllowInvalid(allow) { rule.allowInvalid = allow; return b; },
            build() { return rule; },
          };
          return b;
        },
      },
      LockService: { getScriptLock: () => lock, getDocumentLock: () => docLock, getUserLock: () => docLock },
      ScriptApp,
      PropertiesService: {
        getDocumentProperties: () => ({
          getProperty: (k) => (k in store ? store[k] : null),
          setProperty(k, v) { store[k] = String(v); return this; },
          deleteProperty(k) { delete store[k]; return this; },
        }),
      },
      Utilities: {
        formatDate(date, tz, format) {
          if (format !== 'yyyy-MM-dd') throw new Error('mock formatDate only supports yyyy-MM-dd');
          return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
        },
        // Like Apps Script: decoding gives signed bytes.
        base64DecodeWebSafe(text) {
          const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
          return Array.from(bin, (c) => (c.charCodeAt(0) << 24) >> 24);
        },
        newBlob(bytes) {
          return { getDataAsString: () => new TextDecoder().decode(Uint8Array.from(bytes, (b) => b & 255)) };
        },
        // Doesn't really wait; records the total so tests can check pacing and back-off.
        sleep(ms) {
          mocksState.slept += ms;
          if (ms >= 60000 && gmail && gmail.quotaLeft === 0) gmail.quotaLeft = null; // a minute passed
        },
      },
      HtmlService: {
        createTemplateFromFile(name) {
          const out = { name, setTitle() { return out; }, addMetaTag() { return out; } };
          return { evaluate: () => out };
        },
        createHtmlOutputFromFile(name) { return { getContent: () => '<!-- ' + name + ' -->' }; },
      },
    };
    if (gmail) globals.Gmail = gmail;
    return { globals, ss, store, lock, docLock, gmail, triggers, state: mocksState };
  }

  function toBase64Url(text) {
    let bin = '';
    new TextEncoder().encode(text).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const LABEL_FILTERS = {
    'category:promotions': 'CATEGORY_PROMOTIONS', 'category:social': 'CATEGORY_SOCIAL',
    'in:sent': 'SENT', 'in:drafts': 'DRAFT', 'in:chats': 'CHAT',
  };

  /**
   * Fake Gmail advanced service: a mailbox with history ids. Supports the search
   * terms Sync.gs uses (newer_than:Nd, after:<seconds>, -category:/-in: filters).
   */
  class FakeGmail {
    constructor() {
      this.messages = [];
      this.historyId = 1000;
      this.history = [];
      this.oldestHistoryId = 0; // history.list before this id -> "not found"
      this.calls = { get: 0, list: 0, history: 0 };
      const self = this;
      this.Users = {
        getProfile: () => ({ emailAddress: 'me@example.com', historyId: String(self.historyId) }),
        Messages: {
          list(user, opts) { return self.list(opts || {}); },
          get(user, id) { return self.get(id); },
        },
        History: {
          list(user, opts) { return self.historyList(opts || {}); },
        },
      };
    }

    /** Add a message. `date` is a Date or ISO string; labels e.g. ['CATEGORY_PROMOTIONS']. */
    add(msg) {
      const id = msg.id || 'm' + (this.messages.length + 1);
      const date = msg.date ? new Date(msg.date) : new Date();
      this.messages.push(Object.assign({ labels: ['INBOX'], body: '', html: null }, msg, { id, date }));
      this.historyId += 1;
      this.history.push({ id: this.historyId, messagesAdded: [{ message: { id } }] });
      return id;
    }

    matches(m, q) {
      return String(q || '').split(/\s+/).filter(Boolean).every((term) => {
        const neg = term.startsWith('-');
        const t = neg ? term.slice(1) : term;
        let ok;
        if (/^newer_than:(\d+)d$/.test(t)) ok = m.date.getTime() >= Date.now() - Number(RegExp.$1) * 86400000;
        else if (/^after:(\d+)$/.test(t)) ok = m.date.getTime() > Number(RegExp.$1) * 1000;
        else if (LABEL_FILTERS[t]) ok = m.labels.includes(LABEL_FILTERS[t]);
        else ok = true;
        return neg ? !ok : ok;
      });
    }

    list(opts) {
      this.calls.list += 1;
      const all = this.messages.filter((m) => this.matches(m, opts.q)).sort((a, b) => b.date - a.date);
      const start = Number(opts.pageToken || 0);
      const size = opts.maxResults || 100;
      const page = all.slice(start, start + size);
      const out = { resultSizeEstimate: all.length };
      if (page.length) out.messages = page.map((m) => ({ id: m.id, threadId: m.id }));
      if (start + size < all.length) out.nextPageToken = String(start + size);
      return out;
    }

    get(id) {
      // quotaLeft: how many more fetches succeed before Gmail's per-minute limit (null = unlimited).
      if (this.quotaLeft !== undefined && this.quotaLeft !== null) {
        if (this.quotaLeft <= 0) {
          throw new Error("API call to gmail.users.messages.get failed with error: Quota exceeded for quota metric " +
            "'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'");
        }
        this.quotaLeft -= 1;
      }
      this.calls.get += 1;
      const m = this.messages.find((x) => x.id === id);
      if (!m) throw new Error('API call to gmail.users.messages.get failed with error: Requested entity was not found.');
      const parts = [];
      if (m.body) parts.push({ mimeType: 'text/plain', filename: '', body: { data: toBase64Url(m.body) } });
      if (m.html) parts.push({ mimeType: 'text/html', filename: '', body: { data: toBase64Url(m.html) } });
      return {
        id: m.id, threadId: m.id, labelIds: m.labels, internalDate: String(m.date.getTime()),
        snippet: m.snippet !== undefined ? m.snippet : (m.body || '').slice(0, 120),
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'From', value: m.from || '' }, { name: 'Subject', value: m.subject || '' }],
          parts,
        },
      };
    }

    historyList(opts) {
      this.calls.history += 1;
      const start = Number(opts.startHistoryId);
      if (start < this.oldestHistoryId) {
        throw new Error('API call to gmail.users.history.list failed with error: Requested entity was not found.');
      }
      const entries = this.history.filter((h) => h.id > start);
      const out = { historyId: String(this.historyId) };
      if (entries.length) out.history = entries;
      return out;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createGasMocks };
  else root.createGasMocks = createGasMocks;
})(typeof globalThis !== 'undefined' ? globalThis : this);
