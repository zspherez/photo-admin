export function mergeUniqueByKey<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string
): { items: T[]; added: number } {
  const ids = new Set(current.map(key));
  const appended = incoming.filter((item) => {
    const itemKey = key(item);
    if (ids.has(itemKey)) return false;
    ids.add(itemKey);
    return true;
  });
  return { items: [...current, ...appended], added: appended.length };
}

export function mergeUniqueById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[]
): { items: T[]; added: number } {
  return mergeUniqueByKey(current, incoming, (item) => item.id);
}

export function shouldAutomaticallyLoadMore(options: {
  intersectionObserver: boolean;
  reducedMotion: boolean;
  saveData: boolean;
}): boolean {
  return (
    options.intersectionObserver &&
    !options.reducedMotion &&
    !options.saveData
  );
}
