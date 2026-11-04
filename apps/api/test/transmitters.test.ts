import { describe, expect, it } from 'vitest';
import { decodeEntities, parseStatePage, STATES } from '../src/seed/parse-transmitters';
import { loadTransmitters } from '../src/seed/demo';
import { assertSeedAllowed } from '../src/seed/guard';

const page = (rows: string) => `<h1>x</h1><table class="d" id="siteList"><thead><td>Coverage Area</td></thead><tbody>${rows}</tbody></table>`;
const stars = (n: number) => '<img class="power-star" />'.repeat(n);
const row = (area: string, id: number, name: string, detail: string, title: string, n: number, state = 'NSW') =>
  `<tr><td class="linked"><a href="transmitters/${state}/${id}-x" title="${area}">${area}</a></td>` +
  `<td class="linked"><a href="transmitters/${state}/${id}-x" title="${title}">${name}</a></td>` +
  `<td class="linked"><a href="transmitters/${state}/${id}-x" title="${title}">${detail}</a></td><td class="powerStars">${stars(n)}</td></tr>`;

describe('parseStatePage', () => {
  it('reads name, detail, description, coverage area, stars and id', () => {
    const [s] = parseStatePage(page(row('Canberra', 3, ' Black Mountain', 'Telecom Tower', 'Telecom Tower Black Mountain', 5, 'ACT')), 'ACT');
    expect(s).toEqual({
      id: 3, name: 'Black Mountain', detail: 'Telecom Tower', description: 'Telecom Tower Black Mountain',
      coverageAreas: ['Canberra'], powerStars: 5, path: 'transmitters/ACT/3-x',
    });
  });
  it('decodes entities and collapses whitespace', () => {
    const [s] = parseStatePage(page(row('Tom &amp; Jerry', 7, 'Mt  Smith &#39;N&#39; Co', 'A&nbsp;B', 'Cnr  A &amp; B Rd', 1)), 'NSW');
    expect(s!.coverageAreas).toEqual(['Tom & Jerry']);
    expect(s!.name).toBe("Mt Smith 'N' Co");
    expect(s!.description).toBe('Cnr A & B Rd');
  });
  it('merges a site listed under several coverage areas and keeps 0 and 6 star counts', () => {
    const r = parseStatePage(page(row('North', 9, 'Hill', 'Multiple', 't', 6) + row('South', 9, 'Hill', 'Multiple', 't', 6) + row('Far', 10, 'Dim', 'x', 't', 0)), 'NSW');
    expect(r).toHaveLength(2);
    expect(r[0]!.coverageAreas).toEqual(['North', 'South']);
    expect(r[0]!.powerStars).toBe(6);
    expect(r[1]!.powerStars).toBe(0);
  });
  it('fails loudly when the layout changes', () => {
    expect(() => parseStatePage('<html>nothing</html>', 'NSW')).toThrow(/no table#siteList/);
    expect(() => parseStatePage(page('<tr><td><a href="oops">a</a></td><td><a href="oops">b</a></td><td>c</td><td></td></tr>'), 'NSW')).toThrow(/site id/);
  });
  it('decodeEntities handles numeric and hex forms', () => {
    expect(decodeEntities('&#65;&#x42;&amp;&unknown;')).toBe('AB&&unknown;');
  });
});

describe('transmitters.json fixture', () => {
  const fixture = loadTransmitters();
  it('covers every state with named sites and unique ids', () => {
    expect(fixture.states.map((s) => s.code)).toEqual(STATES.map((s) => s.code));
    for (const st of fixture.states) {
      expect(st.sites.length, st.code).toBeGreaterThan(0);
      expect(new Set(st.sites.map((s) => s.id)).size, st.code).toBe(st.sites.length);
      for (const s of st.sites) {
        expect(s.name.length, `${st.code}-${s.id}`).toBeGreaterThan(0);
        expect(s.powerStars).toBeGreaterThanOrEqual(0);
        expect(s.powerStars).toBeLessThanOrEqual(6);
        expect(s.path).toContain(`transmitters/${st.code}/${s.id}-`);
      }
    }
  });
  it('records where the data came from', () => {
    expect(fixture.source.url).toBe('https://ozdigitaltv.com/transmitters');
    expect(fixture.source.attribution).toMatch(/Australian Communications and Media Authority/);
  });
});

describe('assertSeedAllowed', () => {
  it('allows local databases', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(() => assertSeedAllowed(`postgres://u:p@${host}:5432/db`, {})).not.toThrow();
  });
  it('refuses remote databases unless overridden', () => {
    expect(() => assertSeedAllowed('postgres://u:p@db.prod.example.com/app', {})).toThrow(/Refusing/);
    expect(() => assertSeedAllowed('postgres://u:p@db.prod.example.com/app', { ALLOW_REMOTE_SEED: '1' })).not.toThrow();
  });
  it('rejects a missing or malformed URL', () => {
    expect(() => assertSeedAllowed(undefined, {})).toThrow(/required/);
    expect(() => assertSeedAllowed('not a url', {})).toThrow(/valid URL/);
  });
});
