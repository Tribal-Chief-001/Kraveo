/**
 * Prisma loads a nested relation (a restaurant's cuisines -> category) with a SECOND query. If a category is merged away between the two
 * (the link moved, the old category row deleted) Prisma throws "Inconsistent query result" although nothing is wrong: reading again gives
 * the consistent picture. Only reads that include the cuisines are wrapped; any other error is thrown at once.
 */
export const retryStaleRead = async <T>(read: () => Promise<T>, attempts = 4): Promise<T> => {
  for (let i = 1; ; i += 1) {
    try {
      return await read();
    } catch (e) {
      if (i >= attempts || !/Inconsistent query result/i.test(String((e as { message?: unknown })?.message ?? ''))) throw e;
    }
  }
};
