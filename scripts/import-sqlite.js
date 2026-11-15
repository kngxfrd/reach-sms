import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sqlitePath = process.env.SQLITE_PATH ? join(root, process.env.SQLITE_PATH) : join(root, 'data', 'reach.sqlite');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL before running db:import-sqlite.');
const sqlite = new DatabaseSync(sqlitePath);
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const tables = {
  users: ['id','name','email','password_hash','created_at'],
  wallets: ['id','user_id','credits','updated_at'],
  contacts: ['id','user_id','first_name','last_name','phone','consent','created_at'],
  plans: ['id','name','credits','price_ghs'],
  purchases: ['id','user_id','plan_id','reference','credits','amount_ghs','status','gateway','created_at'],
  campaigns: ['id','user_id','name','audience','message','recipients','recipient_numbers','credits_used','status','provider','provider_message_ids','scheduled_for','sender_id','created_at'],
  drafts: ['id','user_id','name','audience','message','recipient_numbers','sender_id','scheduled_for','created_at','updated_at'],
  sender_submissions: ['id','user_id','provider_id','name','use_case','sample_message','notes','status','created_at']
};
const nullable = new Set(['user_id','reference','gateway','provider','provider_message_ids','scheduled_for','sender_id','recipient_numbers']);
try {
  await pool.query('BEGIN');
  for (const [table, columns] of Object.entries(tables)) {
    let rows;
    try { rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all(); } catch { continue; }
    for (const row of rows) {
      const values = columns.map((column) => row[column] ?? (nullable.has(column) ? null : undefined));
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
      await pool.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
    }
    if (columns.includes('id')) await pool.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 1), 1), true)`);
    console.log(`Imported ${rows.length} ${table} rows.`);
  }
  await pool.query('COMMIT');
  console.log('SQLite import complete. Original SQLite file was not changed.');
} catch (error) { await pool.query('ROLLBACK'); throw error; } finally { sqlite.close(); await pool.end(); }
