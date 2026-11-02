#!/usr/bin/env node
/**
 * Turn a backup JSON (backups/YYYY-MM-DD.json on the `backups` branch) into SQL for D1:
 *   node scripts/restore-backup.mjs backups/2026-11-08.json > restore.sql
 *   npx wrangler d1 execute life_os --remote --file restore.sql
 * Rows are written with INSERT OR REPLACE, so existing rows with the same id are overwritten.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/restore-backup.mjs <backup.json>');
  process.exit(1);
}
const { tables } = JSON.parse(readFileSync(file, 'utf8'));
const literal = v => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
for (const [table, rows] of Object.entries(tables)) {
  for (const row of rows) {
    const cols = Object.keys(row);
    console.log(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => literal(row[c])).join(', ')});`);
  }
}
