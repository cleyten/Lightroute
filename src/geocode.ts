// Address/place search via Photon (photon.komoot.io), a free OSM-based
// geocoder with no API key. Results are biased towards the map center.

export interface GeocodeResult {
  label: string;
  detail: string;
  lngLat: [number, number];
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_value?: string;
  };
}

export async function searchPlaces(
  query: string,
  bias: [number, number],
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const url =
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}` +
    `&limit=5&lon=${bias[0].toFixed(3)}&lat=${bias[1].toFixed(3)}&lang=en`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Address search failed.');
  const data = (await response.json()) as { features: PhotonFeature[] };
  const results: GeocodeResult[] = [];
  const seen = new Set<string>();
  for (const f of data.features) {
    const p = f.properties;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const label = p.name ?? street ?? 'Unnamed';
    const detail = [street !== label ? street : null, p.city, p.country]
      .filter(Boolean)
      .join(', ');
    // Photon often returns the same place as several OSM elements
    // (square + street + area); show each label/detail pair once.
    const key = `${label}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ label, detail, lngLat: f.geometry.coordinates });
  }
  return results;
}
