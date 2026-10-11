import tagCollections from '../content/tag-collections.json' with { type: 'json' };
export const emotions = tagCollections;
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function matchesEmotion(photo, emotion, series = []) {
  if (photo.data.emotions?.length) return photo.data.emotions.includes(emotion.slug);
  const parent = series.find(item => item.data.slug === photo.data.series);
  if (parent?.data.emotions?.length) return parent.data.emotions.includes(emotion.slug);
  const tags = [...photo.data.tags, ...(parent?.data.tags || [])].map(normalize);
  return emotion.tags.some(word => tags.some(tag => tag.includes(word)));
}
export function guidedSelection(photos, pinned = []) {
  const selected = pinned.map(slug => photos.find(photo => photo.data.slug === slug)).filter(Boolean);
  if (selected.length) return [...new Map(selected.map(photo => [photo.data.slug, photo])).values()].slice(0, 12);
  const groups = new Map();
  for (const photo of [...photos].sort((a,b) => a.data.slug.localeCompare(b.data.slug))) {
    const key = photo.data.series || 'instants';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(photo);
  }
  for (let round = 0; selected.length < Math.min(12, photos.length); round++) {
    for (const group of groups.values()) if (group[round] && selected.length < 12) selected.push(group[round]);
  }
  return selected;
}

export function narrativeChapters(photos, size = 12) {
  const remaining = photos.slice(1).map((photo, offset) => ({...photo, index: offset + 1, paired: false}));
  const sequence = [];
  while (remaining.length) {
    const photo = remaining.shift();
    const partnerIndex = remaining.findIndex(other => other.slug === photo.diptych_with || other.diptych_with === photo.slug);
    if (partnerIndex >= 0) {
      const partner = remaining.splice(partnerIndex, 1)[0];
      sequence.push({...photo, paired:true, pair:photo.slug}, {...partner, paired:true, pair:photo.slug});
    } else sequence.push(photo);
  }
  const chapters = [];
  let chapter = [];
  for (let index = 0; index < sequence.length; index++) {
    const photo = sequence[index];
    if (chapter.length >= size && !(photo.paired && sequence[index - 1]?.pair === photo.pair)) {
      chapters.push(chapter);
      chapter = [];
    }
    chapter.push(photo);
  }
  if (chapter.length) chapters.push(chapter);
  return chapters;
}
