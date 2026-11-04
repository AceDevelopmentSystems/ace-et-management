// Rebuilds src/seed/transmitters.json from https://ozdigitaltv.com/transmitters/<STATE>.
//
//   npx tsx src/seed/build-transmitters.ts                  # fetch the 8 state pages (2 s apart) and write the fixture
//   npx tsx src/seed/build-transmitters.ts --from-dir DIR   # parse saved DIR/<STATE>.html files instead (no network)
//
// This is a one-off tool: the committed JSON is what the demo seed and tests use, so nothing hits the website
// at seed or test time. The site credits "Based on Australian Communications and Media Authority data".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES, TransmitterFixture, parseStatePage } from './parse-transmitters';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'transmitters.json');
const BASE = 'https://ozdigitaltv.com/transmitters';
const UA = 'ace-et-management-seed/0.1 (one-off fixture build)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dirIdx = process.argv.indexOf('--from-dir');
  const dir = dirIdx >= 0 ? process.argv[dirIdx + 1] : undefined;
  if (dirIdx >= 0 && !dir) throw new Error('--from-dir needs a directory');

  const fixture: TransmitterFixture = {
    source: {
      url: BASE,
      attribution: 'Transmitter site list from ozdigitaltv.com, which states it is based on Australian Communications and Media Authority data.',
      fetchedOn: new Date().toISOString().slice(0, 10),
    },
    states: [],
  };

  for (const [i, st] of STATES.entries()) {
    let html: string;
    if (dir) {
      html = readFileSync(join(dir, `${st.code}.html`), 'utf8');
    } else {
      if (i > 0) await sleep(2000); // be polite: one request every two seconds
      const res = await fetch(`${BASE}/${st.code}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${st.code}: HTTP ${res.status}`);
      html = await res.text();
    }
    const sites = parseStatePage(html, st.code);
    if (sites.length === 0) throw new Error(`${st.code}: parsed 0 sites, refusing to write an empty state`);
    console.log(`${st.code.padEnd(4)} ${String(sites.length).padStart(4)} sites`);
    fixture.states.push({ ...st, sites });
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(fixture, null, 1) + '\n');
  console.log(`Wrote ${OUT} (${fixture.states.reduce((n, s) => n + s.sites.length, 0)} sites)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
