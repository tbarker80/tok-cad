// Nightly backup of TOK CAD's account databases (run by the "TOK-CAD-Backup" scheduled task).
// VACUUM INTO writes a consistent snapshot of a live WAL database; copying the files could
// catch a write half done. Keeps 14 days.
//   node backup.mjs [dataDir] [backupDir]
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.argv[2] ?? 'D:\\apps\\tokcad-data';
const backupDir = process.argv[3] ?? 'D:\\apps\\tokcad-backups';
const KEEP_DAYS = 14;

const stamp = new Date().toISOString().slice(0, 10);
const target = join(backupDir, stamp);
mkdirSync(target, { recursive: true });
for (const name of ['partmode.sqlite', 'tokcad.sqlite']) {
  const out = join(target, name);
  rmSync(out, { force: true });
  const db = new DatabaseSync(join(dataDir, name), { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  console.log(`${name} -> ${out} (${statSync(out).size} bytes)`);
}
const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
for (const day of readdirSync(backupDir)) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Date.parse(day) < cutoff) {
    rmSync(join(backupDir, day), { recursive: true, force: true });
    console.log(`pruned ${day}`);
  }
}
