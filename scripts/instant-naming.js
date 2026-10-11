export function cleanInstantTitle(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}

export function instantPhotoTitle({ title, place, date }, usedTitles = new Set()) {
  const personal = cleanInstantTitle(title);
  if (personal) return personal;
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T12:00:00Z`))) {
    throw new Error('Date de prise de vue invalide');
  }
  const formatted = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  const label = cleanInstantTitle(place);
  const base = label ? `${label} — ${formatted}` : `Instant du ${formatted}`;
  let candidate = base;
  let number = 2;
  while (usedTitles.has(candidate)) candidate = `${base} — ${String(number++).padStart(2, '0')}`;
  return candidate;
}
