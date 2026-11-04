import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app';
import { createPgDatabase, migrate } from './db';

async function main() {
  const url = process.env.DATABASE_URL;
  const secret = process.env.JWT_SECRET;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET is required (at least 32 characters)');
  const db = await createPgDatabase(url);
  const applied = await migrate(db);
  if (applied.length) console.log('Applied migrations:', applied.join(', '));
  const app = await NestFactory.create(AppModule.register(db, { jwtSecret: secret }));
  app.setGlobalPrefix('api');
  await app.listen(Number(process.env.PORT ?? 3000));
}
main().catch((e) => { console.error(e); process.exit(1); });
