// Parser for the state pages at https://ozdigitaltv.com/transmitters/<STATE> (table#siteList).
// Pure functions so they can be unit tested on a small HTML snippet.

export interface TransmitterSite {
  /** Numeric id from the site's page URL, e.g. 3 for transmitters/ACT/3-Black-Mountain. Unique within the state. */
  id: number;
  name: string;
  /** Extra text shown beside the name, e.g. "Telecom Tower" or "Multiple". */
  detail: string;
  /** Fuller description from the link's title attribute (often a street address or tower name). */
  description: string;
  /** Areas served by this site (a site can be listed under several). */
  coverageAreas: string[];
  /** Relative transmitter power as the number of stars the site shows (0-6; 0 means none shown). */
  powerStars: number;
  path: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Parse one state page. Sites listed under several coverage areas are merged by id. */
export function parseStatePage(html: string, stateCode: string): TransmitterSite[] {
  const table = html.match(/<table[^>]*id="siteList"[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (table === undefined) throw new Error(`${stateCode}: no table#siteList found (page layout changed?)`);
  const body = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? table;
  const byId = new Map<number, TransmitterSite>();

  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!);
    if (cells.length < 4) continue; // header or malformed row
    const attrs = cells[1]!.match(/<a\b([^>]*)>/i)?.[1] ?? '';
    const path = attrs.match(/href="([^"]*)"/i)?.[1] ?? '';
    const title = attrs.match(/title="([^"]*)"/i)?.[1] ?? '';
    const id = Number(path.match(new RegExp(`transmitters/${stateCode}/(\\d+)-`, 'i'))?.[1]);
    if (!Number.isInteger(id)) throw new Error(`${stateCode}: cannot read a site id from "${path}"`);

    const area = text(cells[0]!);
    const existing = byId.get(id);
    if (existing) {
      if (area && !existing.coverageAreas.includes(area)) existing.coverageAreas.push(area);
      continue;
    }
    byId.set(id, {
      id,
      name: text(cells[1]!),
      detail: text(cells[2]!),
      description: decodeEntities(title).replace(/\s+/g, ' ').trim(),
      coverageAreas: area ? [area] : [],
      powerStars: (cells[3]!.match(/power-star/g) ?? []).length,
      path,
    });
  }
  return [...byId.values()];
}

export const STATES: { code: string; name: string }[] = [
  { code: 'ACT', name: 'Australian Capital Territory' },
  { code: 'NSW', name: 'New South Wales' },
  { code: 'NT', name: 'Northern Territory' },
  { code: 'QLD', name: 'Queensland' },
  { code: 'SA', name: 'South Australia' },
  { code: 'TAS', name: 'Tasmania' },
  { code: 'VIC', name: 'Victoria' },
  { code: 'WA', name: 'Western Australia' },
];

export interface TransmitterFixture {
  source: { url: string; attribution: string; fetchedOn: string };
  states: { code: string; name: string; sites: TransmitterSite[] }[];
}
