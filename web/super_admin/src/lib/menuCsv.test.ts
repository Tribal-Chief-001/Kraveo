import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_ROWS, detectDelimiter, fieldForHeader, menuTemplateCsv, parseAvailableValue, parseMenuCsv, parsePriceCell, parseVegValue, tokenise,
} from './menuCsv';

describe('tokenise (RFC 4180)', () => {
  it('splits plain records', () => {
    expect(tokenise('a,b,c\n1,2,3\n', ',').records).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('handles CRLF, lone CR and a missing final newline', () => {
    expect(tokenise('a,b\r\n1,2\r\n3,4', ',').records).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(tokenise('a,b\r1,2', ',').records).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('quoted fields keep commas, doubled quotes and line breaks', () => {
    const t = tokenise('name,desc\n"Roll, special","He said ""hi"""\n"Two\nlines",x\n', ',');
    expect(t.records).toEqual([['name', 'desc'], ['Roll, special', 'He said "hi"'], ['Two\nlines', 'x']]);
    expect(t.unterminatedQuote).toBe(false);
  });
  it('tracks the file line of each record (a quoted line break moves later numbers)', () => {
    expect(tokenise('a\n"x\ny"\nz\n\nlast', ',').lines).toEqual([1, 2, 4, 6]);
  });
  it('drops blank lines and rows that are only delimiters; keeps empty cells inside real rows', () => {
    expect(tokenise('a,b\n\n,\n   \n1,\n', ',').records).toEqual([['a', 'b'], ['1', '']]);
  });
  it('strips a UTF-8 BOM', () => {
    expect(tokenise('﻿name,price\nx,1', ',').records[0]).toEqual(['name', 'price']);
  });
  it('reports an unterminated quote', () => {
    expect(tokenise('a,b\n"open,1\n', ',').unterminatedQuote).toBe(true);
  });
  it('a quote in the middle of an unquoted value is plain text', () => {
    expect(tokenise('5" pizza,x', ',').records).toEqual([['5" pizza', 'x']]);
  });
  it('an empty quoted value is empty', () => {
    expect(tokenise('a,"",c', ',').records).toEqual([['a', '', 'c']]);
  });
  it('empty input has no records', () => {
    expect(tokenise('', ',').records).toEqual([]);
    expect(tokenise('\n\n', ',').records).toEqual([]);
  });
});

describe('detectDelimiter', () => {
  it('picks comma, semicolon or tab from the first line', () => {
    expect(detectDelimiter('name,category,price')).toBe(',');
    expect(detectDelimiter('name;category;price')).toBe(';');
    expect(detectDelimiter('name\tcategory\tprice')).toBe('\t');
  });
  it('ignores delimiters inside quotes and later lines', () => {
    expect(detectDelimiter('"a,b,c";d;e\n1,2,3,4,5,6')).toBe(';');
  });
  it('skips a BOM and leading blank lines; defaults to comma', () => {
    expect(detectDelimiter('﻿\n\nname;price')).toBe(';');
    expect(detectDelimiter('justone')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});

describe('header aliases and values', () => {
  it('maps the common spellings', () => {
    expect(fieldForHeader('Price')).toBe('vendorPrice');
    expect(fieldForHeader(' Vendor Price ')).toBe('vendorPrice');
    expect(fieldForHeader('vendorPrice')).toBe('vendorPrice');
    expect(fieldForHeader('Veg')).toBe('isVeg');
    expect(fieldForHeader('Veg / Non-veg')).toBe('isVeg');
    expect(fieldForHeader('Photo')).toBe('imageUrl');
    expect(fieldForHeader('image')).toBe('imageUrl');
    expect(fieldForHeader('Dish name')).toBe('name');
    expect(fieldForHeader('Available')).toBe('isAvailable');
    expect(fieldForHeader('colour')).toBeNull();
  });
  it('veg values', () => {
    for (const v of ['yes', 'YES', 'y', 'true', 'TRUE', '1', 'veg', 'Veg', 'vegetarian']) expect(parseVegValue(v)).toBe(true);
    for (const v of ['no', 'n', 'false', '0', 'non-veg', 'Non Veg', 'nonveg', 'non-vegetarian']) expect(parseVegValue(v)).toBe(false);
    for (const v of ['maybe', 'egg', '2']) expect(parseVegValue(v)).toBeNull();
  });
  it('availability values', () => {
    for (const v of ['yes', 'true', '1', 'available', 'In stock']) expect(parseAvailableValue(v)).toBe(true);
    for (const v of ['no', 'false', '0', 'sold out', 'Out of stock', 'unavailable']) expect(parseAvailableValue(v)).toBe(false);
    expect(parseAvailableValue('veg')).toBeNull();
  });
  it('price cells', () => {
    expect(parsePriceCell('120')).toBe(120);
    expect(parsePriceCell(' 120.50 ')).toBe(120.5);
    expect(parsePriceCell('₹120')).toBe(120);
    expect(parsePriceCell('Rs. 99')).toBe(99);
    expect(parsePriceCell('Rs 99/-')).toBe(99);
    expect(parsePriceCell('1,200')).toBe(1200);
    expect(parsePriceCell('1,2')).toBeNull();
    expect(parsePriceCell('abc')).toBeNull();
    expect(parsePriceCell('')).toBeNull();
    expect(parsePriceCell('-5')).toBeNull();
    expect(parsePriceCell('1e3')).toBeNull();
    expect(parsePriceCell('Infinity')).toBeNull();
  });
});

describe('parseMenuCsv', () => {
  it('reads the template header and a full row', () => {
    const r = parseMenuCsv('name,category,vendorPrice,isVeg,description,imageUrl,isAvailable\nPaneer Tikka,Starters,120,yes,"Grilled, smoky",https://x.test/a.jpg,no\n');
    expect(r.fileProblems).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({
      line: 2, issues: [],
      input: { name: 'Paneer Tikka', category: 'Starters', vendorPrice: 120, isVeg: true, description: 'Grilled, smoky', imageUrl: 'https://x.test/a.jpg', isAvailable: false },
    });
  });

  it('accepts aliases, semicolons, BOM, CRLF and trims every cell', () => {
    const text = '﻿Dish;Category;Price;Veg;Photo\r\n  Masala   Chai ; Beverages ; 20 ; veg ; https://x.test/c.png \r\n';
    const r = parseMenuCsv(text);
    expect(r.delimiter).toBe(';');
    expect(r.fileProblems).toEqual([]);
    expect(r.rows[0].input).toEqual({ name: 'Masala Chai', category: 'Beverages', vendorPrice: 20, isVeg: true, imageUrl: 'https://x.test/c.png' });
  });

  it('accepts tab separated text pasted from a spreadsheet', () => {
    const r = parseMenuCsv('name\tcategory\tprice\nChai\tBeverages\t15\nSamosa\tSnacks\t12');
    expect(r.delimiter).toBe('\t');
    expect(r.rows.map((x) => x.input.name)).toEqual(['Chai', 'Samosa']);
    expect(r.rows.map((x) => x.input.vendorPrice)).toEqual([15, 12]);
  });

  it('empty cells are left out (not sent), so an update keeps the current value', () => {
    const r = parseMenuCsv('name,category,price,veg,description,image,available\nTea,Beverages,10,,,,\n');
    expect(r.rows[0].input).toEqual({ name: 'Tea', category: 'Beverages', vendorPrice: 10 });
    expect(Object.keys(r.rows[0].input)).toEqual(['name', 'category', 'vendorPrice']);
  });

  it('flags unclear values in plain words but still sends the raw text so the server rejects the row too', () => {
    const r = parseMenuCsv('name,category,price,veg,available\nA,B,twelve,maybe,perhaps\n');
    expect(r.rows[0].input).toMatchObject({ vendorPrice: 'twelve', isVeg: 'maybe', isAvailable: 'perhaps' });
    expect(r.rows[0].issues.map((i) => i.field)).toEqual(['vendorPrice', 'isVeg', 'isAvailable']);
    expect(r.rows[0].issues[0].message).toContain('not a price');
  });

  it('unknown columns are ignored and listed', () => {
    const r = parseMenuCsv('name,category,price,colour,\nTea,Beverages,10,red,x\n');
    expect(r.ignoredColumns).toEqual(['colour']);
    expect(r.rows[0].input).toEqual({ name: 'Tea', category: 'Beverages', vendorPrice: 10 });
    expect(r.rows[0].issues).toEqual([]); // the trailing unnamed column holds a value but the row is otherwise fine
  });

  it('missing required columns are a file problem naming them', () => {
    const r = parseMenuCsv('name,price\nTea,10\n');
    expect(r.fileProblems[0]).toContain('Missing: category');
    expect(parseMenuCsv('foo,bar\n1,2').fileProblems[0]).toContain('name, category, price (vendorPrice)');
  });

  it('a repeated column is a file problem', () => {
    const r = parseMenuCsv('name,category,price,cost\nTea,Beverages,10,12\n');
    expect(r.fileProblems.join(' ')).toContain('same column twice');
  });

  it('a row with more values than columns is flagged (typical unquoted comma)', () => {
    const r = parseMenuCsv('name,category,price\nRoll, special,Snacks,50\n');
    expect(r.rows[0].issues[0]).toMatchObject({ field: 'row' });
    expect(r.rows[0].issues[0].message).toContain('more values');
  });

  it('short rows are fine (missing cells are empty)', () => {
    const r = parseMenuCsv('name,category,price,veg\nTea,Beverages\n');
    expect(r.rows[0].input).toEqual({ name: 'Tea', category: 'Beverages' });
  });

  it('skips blank lines but keeps the real line numbers', () => {
    const r = parseMenuCsv('name,category,price\n\nA,B,1\n\n\nC,D,2\n');
    expect(r.rows.map((x) => x.line)).toEqual([3, 6]);
  });

  it('exactly 200 rows are fine, 201 are a clear file problem', () => {
    const body = (n: number) => `name,category,price\n${Array.from({ length: n }, (_, i) => `Dish ${i},Snacks,10`).join('\n')}`;
    expect(parseMenuCsv(body(MAX_IMPORT_ROWS)).fileProblems).toEqual([]);
    const over = parseMenuCsv(body(MAX_IMPORT_ROWS + 1));
    expect(over.fileProblems[0]).toBe('This file has 201 dishes, but at most 200 can be imported at a time. Split the file into parts of 200 or fewer and import them one after another.');
  });

  it('empty text, only a header, an unclosed quote', () => {
    expect(parseMenuCsv('').fileProblems[0]).toContain('empty');
    expect(parseMenuCsv('   \n\n').fileProblems[0]).toContain('empty');
    expect(parseMenuCsv('name,category,price\n').fileProblems[0]).toContain('no dishes');
    expect(parseMenuCsv('name,category,price\n"Tea,Beverages,10\n').fileProblems.join(' ')).toContain('never closed');
  });

  it('never throws on garbage', () => {
    for (const junk of ['\u0000\u0001', '"""', ',,,,', '\n\n,\n', 'name', '{"a":1}', '﻿']) {
      expect(() => parseMenuCsv(junk)).not.toThrow();
      expect(parseMenuCsv(junk).rows.every((r) => Number.isFinite(r.line))).toBe(true);
    }
  });

  it('keeps Hindi and emoji text and quotes inside values', () => {
    const r = parseMenuCsv('name,category,price,description\n"पनीर टिक्का 🍢","Starters",150,"Called ""the best"""\n');
    expect(r.rows[0].input).toMatchObject({ name: 'पनीर टिक्का 🍢', description: 'Called "the best"' });
  });

  it('the downloadable template parses back into its own two sample rows', () => {
    const template = menuTemplateCsv();
    expect(template.startsWith('name,category,vendorPrice,isVeg,description,imageUrl,isAvailable\r\n')).toBe(true);
    const r = parseMenuCsv(template);
    expect(r.fileProblems).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1].input).toMatchObject({ isVeg: false });
  });
});
