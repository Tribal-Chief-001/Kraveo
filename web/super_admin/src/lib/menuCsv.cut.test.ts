import { describe, expect, it } from 'vitest';
import { MENU_PRICE_TEMPLATE_HEADERS, fieldForHeader, menuTemplateCsv, parseMenuCsv, parsePositionCell } from './menuCsv';

describe('Docs/26: menuPrice and position columns', () => {
  it.each(['menuPrice', 'Menu price', 'price (customer)', 'Price (Customer pays)', 'customer price', 'Selling Price', 'MRP'])('header %j is the menu price', (header) => {
    expect(fieldForHeader(header)).toBe('menuPrice');
  });
  it.each(['position', 'Position', 'order', 'Sort Order', 'menu order'])('header %j is the position', (header) => {
    expect(fieldForHeader(header)).toBe('position');
  });
  it('a plain "price" is still the restaurant price', () => {
    expect(fieldForHeader('Price')).toBe('vendorPrice');
    expect(fieldForHeader('vendorPrice')).toBe('vendorPrice');
  });

  it('reads a file with menuPrice and position; the numbers are numbers', () => {
    const r = parseMenuCsv('name,category,menuPrice,position,isVeg\nPaneer Roll,Rolls,115,1,veg\nChicken Roll,Rolls,140.50,2,non-veg\n');
    expect(r.fileProblems).toEqual([]);
    expect(r.rows.map((x) => x.input)).toEqual([
      { name: 'Paneer Roll', category: 'Rolls', menuPrice: 115, position: 1, isVeg: true },
      { name: 'Chicken Roll', category: 'Rolls', menuPrice: 140.5, position: 2, isVeg: false },
    ]);
    expect(r.rows.every((x) => x.issues.length === 0)).toBe(true);
  });

  it('rupee signs and thousands separators work in the menu price', () => {
    const r = parseMenuCsv('name,category,price (customer)\nBig Thali,Meals,"Rs. 1,200"\nSmall,Meals,₹99\n');
    expect(r.rows.map((x) => x.input.menuPrice)).toEqual([1200, 99]);
    expect(r.rows[0].input.vendorPrice).toBeUndefined();
  });

  it('a file with menuPrice and no vendorPrice column is complete', () => {
    expect(parseMenuCsv('name,category,menuPrice\nA,B,10').fileProblems).toEqual([]);
  });

  it('a file with no price column at all names the problem and mentions menuPrice', () => {
    const r = parseMenuCsv('name,category\nA,B');
    expect(r.fileProblems[0]).toContain('price (vendorPrice)');
    expect(r.fileProblems[0]).toContain('menuPrice');
  });

  it('bad cells become plain issues on the row, never an exception', () => {
    const r = parseMenuCsv('name,category,menuPrice,position\nA,B,abc,0\nC,D,10,1.5\nE,F,10,10001\nG,H,10,\n');
    expect(r.rows[0].issues.map((i) => i.field)).toEqual(['menuPrice', 'position']);
    expect(r.rows[0].issues[0].message).toContain('not a menu price');
    expect(r.rows[0].issues[1].message).toContain('whole number from 1 to 10,000');
    expect(r.rows[1].issues.map((i) => i.field)).toEqual(['position']);
    expect(r.rows[2].issues.map((i) => i.field)).toEqual(['position']);
    expect(r.rows[3].issues).toEqual([]);
    expect(r.rows[3].input).toEqual({ name: 'G', category: 'H', menuPrice: 10 });
  });

  it('parsePositionCell', () => {
    expect(parsePositionCell(' 7 ')).toBe(7);
    expect(parsePositionCell('10000')).toBe(10000);
    for (const bad of ['0', '-1', '1.5', 'x', '', '10001', '123456']) expect(parsePositionCell(bad)).toBeNull();
  });

  it('a row with both prices passes through (the server answers PRICE_REQUIRED)', () => {
    const r = parseMenuCsv('name,category,vendorPrice,menuPrice\nA,B,10,12');
    expect(r.rows[0].input).toMatchObject({ vendorPrice: 10, menuPrice: 12 });
  });

  it('pricesAre "menu": a plain Price column holds the customer price; an explicit vendorPrice column stays', () => {
    const plain = parseMenuCsv('Dish,Section,Price\nA,B,115', { pricesAre: 'menu' });
    expect(plain.rows[0].input).toEqual({ name: 'A', category: 'B', menuPrice: 115 });
    expect(plain.fileProblems).toEqual([]);
    const explicit = parseMenuCsv('name,category,vendorPrice\nA,B,80', { pricesAre: 'menu' });
    expect(explicit.rows[0].input).toEqual({ name: 'A', category: 'B', vendorPrice: 80 });
    const restaurant = parseMenuCsv('name,category,restaurant price\nA,B,80', { pricesAre: 'menu' });
    expect(restaurant.rows[0].input.vendorPrice).toBe(80);
    expect(parseMenuCsv('Dish,Section,Price\nA,B,115', { pricesAre: 'vendor' }).rows[0].input).toEqual({ name: 'A', category: 'B', vendorPrice: 115 });
    expect(parseMenuCsv('Dish,Section,Price\nA,B,115').rows[0].input.vendorPrice).toBe(115);
  });

  it('the same column twice is still a file problem', () => {
    expect(parseMenuCsv('name,category,menuPrice,customer price\nA,B,1,2').fileProblems.join(' ')).toContain('same column twice');
  });
});

describe('templates', () => {
  it('the restaurant-price template is unchanged', () => {
    expect(menuTemplateCsv().startsWith('name,category,vendorPrice,isVeg,description,imageUrl,isAvailable\r\n')).toBe(true);
    expect(menuTemplateCsv('vendor')).toBe(menuTemplateCsv());
  });
  it('the menu-price template has menuPrice and position and parses back into its own samples', () => {
    const csv = menuTemplateCsv('menu');
    expect(csv.startsWith(`${MENU_PRICE_TEMPLATE_HEADERS.join(',')}\r\n`)).toBe(true);
    expect(MENU_PRICE_TEMPLATE_HEADERS).toContain('menuPrice');
    expect(MENU_PRICE_TEMPLATE_HEADERS).toContain('position');
    const r = parseMenuCsv(csv);
    expect(r.fileProblems).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].input).toMatchObject({ menuPrice: 115, position: 1 });
    expect(r.rows[1].input).toMatchObject({ menuPrice: 140, position: 2, isVeg: false });
  });
});
