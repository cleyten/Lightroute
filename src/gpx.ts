// Client-side GPX 1.1 export. GPX is the standard XML format that Garmin,
// Wahoo and Strava all accept for planned routes.

export function buildGpx(
  coordinates: [number, number, number][],
  name: string,
): string {
  const trackpoints = coordinates
    .map(
      ([lng, lat, ele]) =>
        `      <trkpt lat="${lat}" lon="${lng}"><ele>${ele ?? 0}</ele></trkpt>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Lightmile" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(name)}</name>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>
`;
}

export function downloadGpx(
  coordinates: [number, number, number][],
  name: string,
): void {
  const gpx = buildGpx(coordinates, name);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[^\w-]+/g, '_')}.gpx`;
  link.click();
  URL.revokeObjectURL(url);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
