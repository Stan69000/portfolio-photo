export const normalizeSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLocaleLowerCase('fr');
export function searchPhotos(photos, {q='', series='', year='', emotion='', tag='', sort='newest'} = {}) {
  const terms = normalizeSearch(q).split(/\s+/).filter(Boolean);
  const matches = photos.filter(photo => {
    const text = normalizeSearch([photo.title,photo.seriesName,...photo.tags,photo.year || ''].join(' '));
    return terms.every(term=>text.includes(term)) && (!series || photo.series===series)
      && (!year || String(photo.year)===String(year)) && (!emotion || photo.emotions.includes(emotion))
      && (!tag || photo.tags.some(value=>normalizeSearch(value)===normalizeSearch(tag)));
  });
  return matches.sort((a,b) => sort==='title' ? a.title.localeCompare(b.title,'fr') :
    (sort==='oldest' ? a.date-b.date : b.date-a.date) || a.slug.localeCompare(b.slug));
}
