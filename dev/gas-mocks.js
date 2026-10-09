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
    const lock = { held: 0, waitLock() { this.held += 1; }, releaseLock() { this.held -= 1; } };

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
      LockService: { getScriptLock: () => lock },
      PropertiesService: {
        getDocumentProperties: () => ({
          getProperty: (k) => (k in store ? store[k] : null),
          setProperty(k, v) { store[k] = String(v); return this; },
        }),
      },
      Utilities: {
        formatDate(date, tz, format) {
          if (format !== 'yyyy-MM-dd') throw new Error('mock formatDate only supports yyyy-MM-dd');
          return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
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
    return { globals, ss, store, lock };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createGasMocks };
  else root.createGasMocks = createGasMocks;
})(typeof globalThis !== 'undefined' ? globalThis : this);
