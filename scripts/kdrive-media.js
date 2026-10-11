export function publicKdriveManifest(photos) {
  return Object.fromEntries(photos.filter(photo => photo.status === 'published' && photo.kdrive).map(photo => [photo.slug, {
    drive_id: photo.kdrive.drive_id,
    files: { thumb: photo.kdrive.files.thumb, web: photo.kdrive.files.web, zoom: photo.kdrive.files.zoom },
  }]));
}
