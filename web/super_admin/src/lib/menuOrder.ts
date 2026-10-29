// Docs/26 section 3 / 7: the order of a restaurant's menu sections and dishes. Pure functions, no DOM, never throw.
// The server lists a restaurant's dishes in menu order (sortOrder, createdAt, id); the sections are the order of first appearance of each category.
// PUT /api/admin/vendors/:id/menu-order takes { sections: [name, ...], dishes?: [{ id, position }] } and answers
// { success, changed, message, count, data: [{ category, dishCount }] } (real shape: Docs/26 section 7.4).

import type { CatalogDish } from './catalogParse';

/** The server's caps (backend services/menuOrder.ts): more than this cannot be saved in one go. */
export const MAX_ORDER_SECTIONS = 60;
export const MAX_ORDER_DISHES = 400;

export interface MenuOrderDish { id: string; name: string; isAvailable: boolean; /** Not live yet (waiting for approval, or rejected): still part of the menu order. */ notLive: boolean }
export interface MenuOrderSection { key: string; category: string; dishes: MenuOrderDish[] }

export interface MenuOrderInput { sections: string[]; dishes: Array<{ id: string; position: number }> }
export interface MenuOrderResult { changed: boolean; message: string; sections: Array<{ category: string; dishCount: number }> }

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Same matching the server uses for section names: ignoring case and spacing. */
export const sectionKey = (category: string): string => category.trim().replace(/\s+/g, ' ').toLowerCase();

/** Dishes already in the server's menu order -> sections in order of first appearance. A dish without a category goes in a last, unnamed section. */
export const buildSections = (dishes: CatalogDish[]): MenuOrderSection[] => {
  const sections: MenuOrderSection[] = [];
  const byKey = new Map<string, MenuOrderSection>();
  for (const dish of dishes) {
    if (dish.state === 'DELETED') continue; // the server never moves deleted dishes
    const key = sectionKey(dish.category);
    let section = byKey.get(key);
    if (!section) {
      section = { key, category: dish.category.trim().replace(/\s+/g, ' '), dishes: [] };
      byKey.set(key, section);
      sections.push(section);
    }
    section.dishes.push({ id: dish.id, name: dish.name, isAvailable: dish.isAvailable, notLive: dish.state === 'PENDING' || dish.state === 'REJECTED' });
  }
  // An unnamed section cannot be named in the request, so the server keeps it after the listed ones: show it there.
  return [...sections.filter((s) => s.key !== ''), ...sections.filter((s) => s.key === '')];
};

/** The list with the item at `index` moved by `delta` places. The same array comes back when the move is not possible. */
export const moveItem = <T,>(list: readonly T[], index: number, delta: -1 | 1): readonly T[] => {
  const target = index + delta;
  if (!Number.isInteger(index) || index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = list.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

export const moveSection = (sections: readonly MenuOrderSection[], key: string, delta: -1 | 1): readonly MenuOrderSection[] => {
  const index = sections.findIndex((s) => s.key === key);
  const target = sections[index + delta];
  if (index < 0 || !target || target.key === '' || sections[index].key === '') return sections; // the unnamed section stays last
  return moveItem(sections, index, delta);
};

export const moveDish = (sections: readonly MenuOrderSection[], key: string, dishId: string, delta: -1 | 1): readonly MenuOrderSection[] => {
  const si = sections.findIndex((s) => s.key === key);
  if (si < 0) return sections;
  const di = sections[si].dishes.findIndex((d) => d.id === dishId);
  const dishes = moveItem(sections[si].dishes, di, delta);
  if (dishes === sections[si].dishes) return sections;
  return sections.map((s, i) => (i === si ? { ...s, dishes: dishes as MenuOrderDish[] } : s));
};

const sectionIds = (sections: readonly MenuOrderSection[]): string => sections.map((s) => `${s.key}:${s.dishes.map((d) => d.id).join(',')}`).join('|');

export const sameOrder = (a: readonly MenuOrderSection[], b: readonly MenuOrderSection[]): boolean => sectionIds(a) === sectionIds(b);

/** How much differs from the saved order, in plain numbers for the "unsaved changes" line. */
export const countChanges = (saved: readonly MenuOrderSection[], now: readonly MenuOrderSection[]): { sections: number; dishes: number } => {
  const place = new Map(saved.map((s, i) => [s.key, i]));
  const sections = now.filter((s, i) => place.get(s.key) !== i).length;
  const savedDish = new Map<string, number>();
  saved.forEach((s) => s.dishes.forEach((d, i) => savedDish.set(d.id, i)));
  const dishes = now.reduce((n, s) => n + s.dishes.filter((d, i) => savedDish.get(d.id) !== i).length, 0);
  return { sections, dishes };
};

export const describeChanges = (counts: { sections: number; dishes: number }): string => {
  const parts: string[] = [];
  if (counts.sections > 0) parts.push(`${counts.sections} ${counts.sections === 1 ? 'section' : 'sections'}`);
  if (counts.dishes > 0) parts.push(`${counts.dishes} ${counts.dishes === 1 ? 'dish' : 'dishes'}`);
  return parts.length === 0 ? 'No changes' : `${parts.join(' and ')} in a new place`;
};

/** The request body: every section in order and every dish with its place (1, 2, 3 ...) inside its section. */
export const toMenuOrderInput = (sections: readonly MenuOrderSection[]): MenuOrderInput => ({
  sections: sections.filter((s) => s.key !== '').map((s) => s.category),
  dishes: sections.flatMap((s) => s.dishes.map((d, i) => ({ id: d.id, position: i + 1 }))),
});

export const countDishes = (sections: readonly MenuOrderSection[]): number => sections.reduce((n, s) => n + s.dishes.length, 0);

/** Why the order cannot be saved from here at all (the server's caps), or null. */
export const orderLimitProblem = (sections: readonly MenuOrderSection[]): string | null => {
  if (sections.length > MAX_ORDER_SECTIONS) return `This menu has ${sections.length} sections, but the order can be saved for at most ${MAX_ORDER_SECTIONS}.`;
  const dishes = countDishes(sections);
  if (dishes > MAX_ORDER_DISHES) return `This menu has ${dishes} dishes, but the order can be saved for at most ${MAX_ORDER_DISHES}.`;
  return null;
};

/** `{ success, changed, message, count, data: [{ category, dishCount }] }`. Null when there is no section list. */
export const parseMenuOrderResult = (body: unknown): MenuOrderResult | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  const sections = body.data.filter(isObject).map((row) => ({
    category: typeof row.category === 'string' ? row.category : '',
    dishCount: typeof row.dishCount === 'number' && Number.isFinite(row.dishCount) ? Math.max(0, Math.round(row.dishCount)) : 0,
  }));
  return { changed: body.changed !== false, message: typeof body.message === 'string' ? body.message : '', sections };
};
