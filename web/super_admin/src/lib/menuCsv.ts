// Client-side reading of a menu CSV for the "Import menu" wizard (Docs/23 section 4).
// Pure functions, no DOM: RFC-4180 quotes (doubled quotes, line breaks inside quotes), commas / semicolons / tabs,
// UTF-8 BOM, CRLF / CR / LF, header aliases, yes/no style values, trimming, and the 200-row limit.
// The server still validates every row; this only turns a file into the rows the import endpoint expects.

export const MAX_IMPORT_ROWS = 200;
/** The server's own limit on the JSON body is 400 KB; a CSV bigger than this is not a menu. */
export const MAX_IMPORT_FILE_BYTES = 400 * 1024;

export const TEMPLATE_HEADERS = ['name', 'category', 'vendorPrice', 'isVeg', 'description', 'imageUrl', 'isAvailable'] as const;
export type ImportField = (typeof TEMPLATE_HEADERS)[number];

export type Delimiter = ',' | ';' | '\t';

/** One dish row as the import endpoint takes it. Cells the file left empty are simply absent. */
export interface ImportRowInput {
  name: string;
  category: string;
  vendorPrice?: number | string;
  isVeg?: boolean | string;
  description?: string;
  imageUrl?: string;
  isAvailable?: boolean | string;
}

export interface CellIssue { field: ImportField | 'row'; message: string }

export interface MenuCsvRow {
  /** 1-based position in the file counting the header as line 1 (what a spreadsheet shows as the row number). */
  line: number;
  input: ImportRowInput;
  /** Problems the dashboard itself found (the server reports its own in the preview). */
  issues: CellIssue[];
}

export interface MenuCsvResult {
  delimiter: Delimiter;
  rows: MenuCsvRow[];
  /** Header names that were not recognised and are ignored. */
  ignoredColumns: string[];
  /** Plain-words reasons the file cannot be imported at all (missing column, too many rows, ...). */
  fileProblems: string[];
}

// ───────────────────────────── tokenising ─────────────────────────────

/** The delimiter used by the first non-empty line (quotes respected). Defaults to a comma. */
export const detectDelimiter = (text: string): Delimiter => {
  const clean = text.replace(/^﻿/, '');
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let seenContent = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '"') { inQuotes = !inQuotes; seenContent = true; continue; }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') { if (seenContent) break; continue; }
    if (ch === ',' || ch === ';' || ch === '\t') counts[ch] += 1;
    if (ch !== ' ') seenContent = true;
  }
  let best: Delimiter = ',';
  for (const d of [',', ';', '\t'] as Delimiter[]) if (counts[d] > counts[best]) best = d;
  return best;
};

export interface Tokenised {
  records: string[][];
  /** The 1-based line of the file each record starts on (a quoted value with a line break makes later numbers jump). */
  lines: number[];
  unterminatedQuote: boolean;
}

/**
 * RFC 4180 reader. A field may be wrapped in double quotes; inside, `""` is one quote and line breaks are kept.
 * Records whose cells are all empty (a blank line, or ",,,," from a spreadsheet) are dropped.
 * A quote in the middle of an unquoted field is kept as text.
 */
export const tokenise = (input: string, delimiter: Delimiter): Tokenised => {
  const text = input.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  const lines: number[] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoted = false; // the current field started with a quote
  let line = 1;
  let recordLine = 1;
  let started = false;

  const endField = () => { record.push(field); field = ''; quoted = false; };
  const endRecord = () => {
    endField();
    if (record.some((cell) => cell.trim() !== '')) { records.push(record); lines.push(recordLine); }
    record = []; started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!started && ch !== '\n' && ch !== '\r') { started = true; recordLine = line; }
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' && !quoted) { inQuotes = true; quoted = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; line++; endRecord(); continue; }
    if (ch === '\n') { line++; endRecord(); continue; }
    field += ch;
  }
  const unterminatedQuote = inQuotes;
  if (started) endRecord();
  return { records, lines, unterminatedQuote };
};

// ───────────────────────────── headers and values ─────────────────────────────

const normalHeader = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES: Record<ImportField, string[]> = {
  name: ['name', 'dish', 'dishname', 'item', 'itemname', 'title'],
  category: ['category', 'categoryname', 'dishcategory', 'section', 'cat'],
  vendorPrice: ['vendorprice', 'price', 'rate', 'cost', 'amount', 'restaurantprice', 'priceinr', 'pricers', 'baseprice'],
  isVeg: ['isveg', 'veg', 'vegetarian', 'vegnonveg', 'vegornonveg', 'foodtype', 'diet'],
  description: ['description', 'desc', 'details', 'about'],
  imageUrl: ['imageurl', 'image', 'photo', 'picture', 'img', 'photourl', 'imagelink', 'photolink', 'pic'],
  isAvailable: ['isavailable', 'available', 'availability', 'instock', 'stock'],
};

const FIELD_BY_ALIAS = new Map<string, ImportField>();
(Object.keys(ALIASES) as ImportField[]).forEach((field) => ALIASES[field].forEach((alias) => FIELD_BY_ALIAS.set(alias, field)));

export const fieldForHeader = (header: string): ImportField | null => FIELD_BY_ALIAS.get(normalHeader(header)) ?? null;

const YES = new Set(['true', 'yes', 'y', '1', 't']);
const NO = new Set(['false', 'no', 'n', '0', 'f']);
const VEG_YES = new Set(['veg', 'vegetarian', 'pure veg']);
const VEG_NO = new Set(['nonveg', 'non-veg', 'non veg', 'nonvegetarian', 'non-vegetarian', 'non vegetarian', 'nv']);
const AVAIL_YES = new Set(['available', 'in stock', 'instock', 'on']);
const AVAIL_NO = new Set(['unavailable', 'not available', 'sold out', 'soldout', 'out of stock', 'outofstock', 'off']);

const flag = (raw: string, yes: Set<string>, no: Set<string>): boolean | null => {
  const v = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (YES.has(v) || yes.has(v)) return true;
  if (NO.has(v) || no.has(v)) return false;
  return null;
};

/** "veg", "yes", "1" -> true; "non-veg", "no", "0" -> false; anything else -> null. */
export const parseVegValue = (raw: string): boolean | null => flag(raw, VEG_YES, VEG_NO);
/** "yes", "available", "1" -> true; "no", "sold out", "0" -> false; anything else -> null. */
export const parseAvailableValue = (raw: string): boolean | null => flag(raw, AVAIL_YES, AVAIL_NO);

/** "120", "120.50", "₹120", "Rs. 1,200", "1200/-" -> a number; anything else -> null. */
export const parsePriceCell = (raw: string): number | null => {
  let v = raw.trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '').replace(/\s*\/-\s*$/, '').replace(/\s+/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const collapse = (value: string): string => value.trim().replace(/\s+/g, ' ');

// ───────────────────────────── the whole file ─────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const tooManyRowsMessage = (count: number): string =>
  `This file has ${plural(count, 'dish', 'dishes')}, but at most ${MAX_IMPORT_ROWS} can be imported at a time. Split the file into parts of ${MAX_IMPORT_ROWS} or fewer and import them one after another.`;

/** Reads CSV / pasted spreadsheet text into import rows. Never throws. */
export const parseMenuCsv = (input: string): MenuCsvResult => {
  const delimiter = detectDelimiter(input);
  const empty = (problem: string): MenuCsvResult => ({ delimiter, rows: [], ignoredColumns: [], fileProblems: [problem] });
  if (typeof input !== 'string' || input.trim() === '') return empty('The file is empty. Add one dish per line under the header row.');

  const { records, lines, unterminatedQuote } = tokenise(input, delimiter);
  if (records.length === 0) return empty('The file is empty. Add one dish per line under the header row.');

  const fileProblems: string[] = [];
  if (unterminatedQuote) fileProblems.push('A quoted value is never closed (a " is missing). Fix it and choose the file again.');

  const header = records[0];
  const columns: Array<ImportField | null> = header.map((cell) => fieldForHeader(cell));
  const ignoredColumns = header.filter((cell, i) => columns[i] === null && cell.trim() !== '').map((cell) => cell.trim());
  const seen = new Set<ImportField>();
  const duplicates = new Set<string>();
  columns.forEach((field, i) => {
    if (!field) return;
    if (seen.has(field)) { duplicates.add(header[i].trim() || field); columns[i] = null; } else seen.add(field);
  });
  if (duplicates.size > 0) fileProblems.push(`The header has the same column twice (${Array.from(duplicates).join(', ')}). Keep one of each.`);

  const missing = (['name', 'category', 'vendorPrice'] as ImportField[]).filter((field) => !seen.has(field));
  if (missing.length > 0) {
    const label: Record<string, string> = { name: 'name', category: 'category', vendorPrice: 'price (vendorPrice)' };
    fileProblems.push(`The first line must name the columns. Missing: ${missing.map((m) => label[m]).join(', ')}. Download the template to see the expected header.`);
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0 && fileProblems.length === 0) fileProblems.push('The file has a header but no dishes. Add one dish per line under it.');
  if (dataRecords.length > MAX_IMPORT_ROWS) fileProblems.push(tooManyRowsMessage(dataRecords.length));

  const rows: MenuCsvRow[] = dataRecords.map((cells, offset) => {
    const issues: CellIssue[] = [];
    const input: ImportRowInput = { name: '', category: '' };
    const line = lines[offset + 1] ?? offset + 2;
    if (cells.length > columns.length && cells.slice(columns.length).some((c) => c.trim() !== '')) {
      issues.push({ field: 'row', message: 'This row has more values than the header has columns. Check for a comma inside a value that is not wrapped in quotes.' });
    }
    columns.forEach((field, i) => {
      if (!field) return;
      const raw = (cells[i] ?? '').trim();
      if (field === 'name') input.name = collapse(raw);
      else if (field === 'category') input.category = collapse(raw);
      else if (raw === '') return; // an empty cell means "not given" (the import keeps the current value of an existing dish)
      else if (field === 'vendorPrice') {
        const price = parsePriceCell(raw);
        if (price === null) issues.push({ field, message: `“${raw}” is not a price. Use a number such as 120 or 120.50.` });
        input.vendorPrice = price ?? raw;
      } else if (field === 'isVeg') {
        const v = parseVegValue(raw);
        if (v === null) issues.push({ field, message: `“${raw}” is not clear. Write veg or non-veg (yes / no also work).` });
        input.isVeg = v ?? raw;
      } else if (field === 'isAvailable') {
        const v = parseAvailableValue(raw);
        if (v === null) issues.push({ field, message: `“${raw}” is not clear. Write yes or no.` });
        input.isAvailable = v ?? raw;
      } else if (field === 'description') input.description = raw;
      else if (field === 'imageUrl') input.imageUrl = raw;
    });
    return { line, input, issues };
  });

  return { delimiter, rows, ignoredColumns, fileProblems };
};

// ───────────────────────────── template ─────────────────────────────

const quoteCell = (value: string): string => (/[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value);

/** Header + two sample lines. The wizard tells the admin to replace the samples. */
export const menuTemplateCsv = (): string => {
  const lines: string[][] = [
    [...TEMPLATE_HEADERS],
    ['Sample Paneer Roll', 'Rolls', '120', 'veg', 'Replace or delete this sample line', '', 'yes'],
    ['Sample Chicken Roll', 'Rolls', '140', 'non-veg', '', '', 'yes'],
  ];
  return `${lines.map((line) => line.map(quoteCell).join(',')).join('\r\n')}\r\n`;
};

export const TEMPLATE_FILENAME = 'kraveo-menu-template.csv';
