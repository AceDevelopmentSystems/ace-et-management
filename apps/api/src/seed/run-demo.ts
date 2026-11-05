// Seed the demo data into the database in DATABASE_URL.
//
//   npm run seed:demo -w @ace/api                      # idempotent: create or top up
//   npm run seed:demo -w @ace/api -- --reset           # delete the demo client first, then rebuild it
//   npm run seed:demo -w @ace/api -- --no-assets       # regions and sites only
//   npm run seed:demo -w @ace/api -- --no-contracts    # skip contractors, contracts and work orders
//   npm run seed:demo -w @ace/api -- --states ACT,TAS  # a subset of states
//   DEMO_PASSWORD=... npm run seed:demo -w @ace/api -- --reset-password   # set the demo user's password
//
// Env: DATABASE_URL (required), DEMO_PASSWORD (optional; otherwise a random password is generated and printed once,
// only when the demo user is created). Refuses non-local databases unless ALLOW_REMOTE_SEED=1.
import { createPgDatabase, migrate } from '../db';
import { DEMO_ORG, seedDemo } from './demo';
import { assertSeedAllowed } from './guard';

async function main() {
  const url = process.env.DATABASE_URL;
  assertSeedAllowed(url);

  const args = process.argv.slice(2);
  const statesIdx = args.indexOf('--states');
  const states = statesIdx >= 0 ? args[statesIdx + 1]?.split(',').filter(Boolean) : undefined;
  if (statesIdx >= 0 && !states?.length) throw new Error('--states needs a comma separated list, e.g. --states ACT,TAS');

  const db = await createPgDatabase(url!);
  try {
    const applied = await migrate(db);
    if (applied.length) console.log('Applied migrations:', applied.join(', '));
    const r = await seedDemo(db, {
      reset: args.includes('--reset'), assets: !args.includes('--no-assets'), states, password: process.env.DEMO_PASSWORD || undefined,
      resetPassword: args.includes('--reset-password'), contracts: !args.includes('--no-contracts'),
    });
    console.log(`Seeded "${DEMO_ORG}": ${r.regions} regions, ${r.sites} sites, ${r.assetTypes} asset types, ${r.assets} assets, ${r.inspections} inspections.`);
    console.log(`Contracts: ${r.contractors} contractors, ${r.contracts} contracts, ${r.contractLines} lines, ${r.workOrders} work orders.`);
    if (r.demoUser.password) console.log(`Demo login created: ${r.demoUser.email} / ${r.demoUser.password}  (shown once; set DEMO_PASSWORD to choose your own)`);
    else console.log(`Demo login: ${r.demoUser.email} (already existed, password unchanged)`);
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
