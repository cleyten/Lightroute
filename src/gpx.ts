// Client-side GPX 1.1 export. GPX is the standard XML format that Garmin,
// Wahoo and Strava all accept for planned routes.

export interface GpxWaypoint {
  lngLat: [number, number];
  label: string;
}

export function buildGpx(
  coordinates: [number, number, number][],
  name: string,
  waypoints: GpxWaypoint[] = [],
): string {
  // Cue-sheet turns as <wpt> elements: Garmin/Wahoo devices show these as
  // on-screen prompts when riding the course, ahead of the actual turn.
  const wpts = waypoints
    .map(
      ({ lngLat: [lng, lat], label }) =>
        `  <wpt lat="${lat}" lon="${lng}"><name>${escapeXml(label)}</name><sym>Turn</sym></wpt>`,
    )
    .join('\n');

  const trackpoints = coordinates
    .map(
      ([lng, lat, ele]) =>
        `      <trkpt lat="${lat}" lon="${lng}"><ele>${ele ?? 0}</ele></trkpt>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Lightroute" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(name)}</name>
  </metadata>
${wpts ? wpts + '\n' : ''}  <trk>
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
  waypoints: GpxWaypoint[] = [],
): void {
  const gpx = buildGpx(coordinates, name, waypoints);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[^\w-]+/g, '_')}.gpx`;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
