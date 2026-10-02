/**
 * One-line, data-free description of an error for server logs. Prisma errors embed the query arguments
 * (phones, emails, codes) in `message`; we keep the class, the code and the first line only.
 */
export const errSummary = (err: unknown): string => {
  const e = err as { name?: string; code?: string; message?: string } | null | undefined;
  if (!e || typeof e !== 'object') return String(err).slice(0, 200);
  const firstLine = String(e.message ?? '').split('\n').find((l) => l.trim()) ?? '';
  return `${e.name ?? 'Error'}${e.code ? ` [${e.code}]` : ''}: ${firstLine.slice(0, 200)}`;
};
