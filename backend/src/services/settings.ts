import { prisma } from '../db';
import { writeAudit } from './audit';
import { AppError } from '../utils/appError';
import { SettingGroup, SettingsMap, SETTING_GROUPS, cloneDefaults, validateSettingGroup, Problem } from './pricing';

/**
 * Admin-editable settings (Docs/21 section 2): one AppSetting row per group, validated on every write, audited with old and new
 * value, read through a small in-process cache that is dropped on every write.
 *
 * A group without a row, or with a stored value that no longer validates (hand-edited in the database), uses the defaults:
 * pricing must never crash an order. The cache lives in this process only; the TTL bounds how stale a second server instance could
 * be (today there is one). Under NODE_ENV=test the TTL is 0 unless SETTINGS_CACHE_TTL_MS is set, because the tests rewrite the
 * table directly.
 */
export class SettingsError extends AppError {
  constructor(status: number, code: string, message: string, field?: string) {
    super(status, code, message, field);
  }
}

const ttlMs = (): number => {
  const raw = process.env.SETTINGS_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return process.env.NODE_ENV === 'test' ? 0 : 30_000;
};

type Cached = { at: number; value: SettingsMap; meta: Record<SettingGroup, SettingMeta> };
export type SettingMeta = { isDefault: boolean; updatedAt: string | null; updatedBy: string | null };
let cache: Cached | null = null;
let generation = 0; // bumped on invalidate so a load that started before a write can never re-fill the cache with old data

export const invalidateSettingsCache = () => {
  cache = null;
  generation++;
};

const loadAll = async (): Promise<Cached> => {
  const started = generation;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: [...SETTING_GROUPS] } } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const value = {} as SettingsMap;
  const meta = {} as Record<SettingGroup, SettingMeta>;
  for (const group of SETTING_GROUPS) {
    const row = byKey.get(group);
    let parsed: unknown = undefined;
    if (row) {
      const check = validateSettingGroup(group, row.value);
      if (check.ok) parsed = check.value;
      else console.error(`setting '${group}' in the database is invalid (${check.error.field}); using the defaults`);
    }
    (value as any)[group] = parsed ?? cloneDefaults(group);
    meta[group] = parsed !== undefined && row ? { isDefault: false, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy ?? null } : { isDefault: true, updatedAt: null, updatedBy: null };
  }
  const loaded: Cached = { at: Date.now(), value, meta };
  if (started === generation && ttlMs() > 0) cache = loaded;
  return loaded;
};

const current = async (): Promise<Cached> => {
  const ttl = ttlMs();
  if (ttl > 0 && cache && Date.now() - cache.at < ttl) return cache;
  return loadAll();
};

/** All four groups (defaults filled in). Never throws for bad stored data. */
export const getSettings = async (): Promise<SettingsMap> => (await current()).value;
export const getSettingGroup = async <G extends SettingGroup>(group: G): Promise<{ value: SettingsMap[G]; meta: SettingMeta }> => {
  const c = await current();
  return { value: c.value[group], meta: c.meta[group] };
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Short human text of what changed, for the audit row (the row holds 300 characters). */
const describeChange = (group: string, before: unknown, after: unknown): string => {
  const parts: string[] = [];
  const b = isObject(before) ? before : {};
  const a = isObject(after) ? after : {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) parts.push(`${key} ${JSON.stringify(b[key])} -> ${JSON.stringify(a[key])}`);
  }
  return `${group}: ${parts.length ? parts.join('; ') : 'saved with no change'}`;
};

/**
 * Admin write. `patch` is merged over the current value of the group (missing keys keep their value), the merged result must
 * validate as a whole (unknown keys, wrong types, out-of-range values and fee lines that do not add up are refused). Runs under a row
 * lock so two admins saving at the same time cannot interleave: the second merges over the first one's result.
 */
export const updateSettingGroup = async <G extends SettingGroup>(group: G, patch: unknown, actorId: string): Promise<{ value: SettingsMap[G]; before: SettingsMap[G]; changed: boolean; meta: SettingMeta }> => {
  if (!isObject(patch)) throw new SettingsError(400, 'BAD_REQUEST', 'Send the settings as a JSON object.', group);
  const run = () =>
    prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ value: unknown }[]>`SELECT "value" FROM "AppSetting" WHERE "key" = ${group} FOR UPDATE`;
        const stored = locked.length > 0 ? validateSettingGroup(group, locked[0].value) : null;
        const before = (stored && stored.ok ? stored.value : cloneDefaults(group)) as SettingsMap[G];
        const merged = { ...(before as object), ...patch };
        const check = validateSettingGroup(group, merged);
        if (!check.ok) throw new SettingsError(400, 'BAD_REQUEST', (check.error as Problem).message, (check.error as Problem).field);
        const row = locked.length > 0
          ? await tx.appSetting.update({ where: { key: group }, data: { value: check.value as any, updatedBy: actorId } })
          : await tx.appSetting.create({ data: { key: group, value: check.value as any, updatedBy: actorId } });
        return { before, value: check.value as SettingsMap[G], row };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  let out;
  try {
    out = await run();
  } catch (err: any) {
    // Two first-time writers of the same group raced on the INSERT: the loser retries once and now sees the winner's row.
    if (err?.code === 'P2002') out = await run();
    else throw err;
  }
  invalidateSettingsCache();
  const changed = JSON.stringify(out.before) !== JSON.stringify(out.value);
  await writeAudit('SETTINGS_UPDATED', 'SETTING', group, describeChange(group, out.before, out.value));
  return { value: out.value, before: out.before, changed, meta: { isDefault: false, updatedAt: out.row.updatedAt.toISOString(), updatedBy: out.row.updatedBy ?? null } };
};
