// Persist only identifiers; invalid selections are replaced when the catalogue changes.
export function visitChoice(items, key, storage) {
  if (!items.length) return undefined;
  try { storage ??= globalThis.sessionStorage; } catch { /* Storage can be unavailable. */ }
  try {
    const saved = storage?.getItem(`gallery:${key}`);
    const existing = items.find(item => item.slug === saved);
    if (existing) return existing;
  } catch { /* Private browsing can disable storage. */ }
  const chosen = items[Math.floor(Math.random() * items.length)];
  try { storage?.setItem(`gallery:${key}`, chosen.slug); } catch { /* The gallery remains usable. */ }
  return chosen;
}
