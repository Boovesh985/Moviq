// Applies every migration in ./migrations in order. Each file is idempotent.
import fs from 'node:fs';
import { pool, query } from './pool.js';

export async function migrate() {
  const dir = new URL('./migrations/', import.meta.url);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await query(fs.readFileSync(new URL(file, dir), 'utf8'));
    console.log(`   applied ${file}`);
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.js')) {
  console.log('→ migrations');
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
