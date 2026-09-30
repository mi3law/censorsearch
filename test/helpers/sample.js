// Loads the gitignored sample list (.xlsx in the repo root) as Row-shaped objects, for tests.
// Reuses the prototype's xlsx reader. Every value becomes the string the sheet displays (1984, not 1984.0).
// Suites that need the sample call hasSample() and skip when it is absent (e.g. in CI).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function samplePath() {
  if (process.env.SAMPLE_XLSX) return process.env.SAMPLE_XLSX;
  const f = fs.readdirSync(ROOT).find(n => n.toLowerCase().endsWith('.xlsx'));
  return f ? path.join(ROOT, f) : null;
}

function hasSample() {
  const p = samplePath();
  return !!p && fs.existsSync(p);
}

const asText = v => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : String(v));

// S<n> = Sheet1 row n, O<n> = Other Materials row n, anything else = its explicit id.
function rowId(r) {
  if (r.testId) return r.testId;
  return (r.tab === 'Sheet1' ? 'S' : r.tab === 'Other Materials' ? 'O' : r.tab + '!') + r.row;
}

function simpleStatus(bannedBy) {
  const b = String(bannedBy || '').trim();
  if (!b) return { level: 'blank', label: 'Status not stated, open the row', codes: [] };
  if (/ministry|\bmoe\b/i.test(b)) return { level: 'ministry', label: 'Must remove (Ministry)', codes: ['Ministry'] };
  if (/\buas\b/i.test(b)) return { level: 'uas', label: 'Banned by UAS', codes: ['UAS'] };
  return { level: 'other', label: `Check case by case (${b})`, codes: [b] };
}

// Returns Row[] for both tabs of the sample (engine tests use both; the app searches Sheet1 only in v1).
function loadSampleRows() {
  if (!hasSample()) throw new Error('sample .xlsx not found in the repo root');
  process.env.SAMPLE_XLSX = samplePath();
  const { load } = require(path.join(ROOT, 'prototype', 'load.js'));
  return load().rows.map((r, id) => toRow(r, id));
}

// Normalizes a partial row (sample or synthetic) into the Row shape of the build contract.
function toRow(r, id) {
  const row = {
    id,
    tab: r.tab || 'Synthetic',
    gid: r.gid || (r.tab === 'Sheet1' ? '0' : r.tab === 'Other Materials' ? '1111920478' : '999'),
    sheetId: 'SAMPLE',
    row: r.row || 1000 + id,
    title: asText(r.title), author: asText(r.author), isbn: asText(r.isbn), bannedBy: asText(r.bannedBy),
    type: asText(r.type), year: asText(r.year), memo: asText(r.memo),
    isbnRaw: '', memoUrl: null, titleUrl: null, hidden: null, section: null, extra: [],
    lastCol: 'G',
  };
  row.status = r.status || simpleStatus(row.bannedBy);
  row.fingerprint = [row.title, row.author, row.bannedBy, row.year].join('|').toLowerCase();
  if (r.id != null && typeof r.id === 'string') row.testId = r.id;
  if (r.testId) row.testId = r.testId;
  return row;
}

module.exports = { hasSample, samplePath, loadSampleRows, toRow, rowId, simpleStatus, ROOT };
