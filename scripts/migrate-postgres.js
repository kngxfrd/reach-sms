import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL before running db:migrate.');
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const sql = await readFile(join(root, 'server', 'migrations', '001_initial.sql'), 'utf8');
  await pool.query(sql);
  await pool.query(`INSERT INTO plans (id, name, credits, price_ghs) VALUES
    ('starter','Starter',100,3),('growth','Growth',500,15),('scale','Scale',1000,30),
    ('launch','Launch',2500,75),('momentum','Momentum',5000,150),('pro','Pro',10000,300),
    ('business','Business',25000,750),('plus','Plus',50000,1500),('enterprise','Enterprise',100000,3000),
    ('volume','Volume',250000,7500),('scale-up','Scale up',500000,15000),('maximum','Maximum',1000000,30000)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, credits=EXCLUDED.credits, price_ghs=EXCLUDED.price_ghs`);
  console.log('PostgreSQL schema and plans are ready.');
} finally { await pool.end(); }
