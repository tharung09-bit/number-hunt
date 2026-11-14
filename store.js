'use strict';
/* Tiny database adapter. Postgres when DATABASE_URL is set (production), otherwise a local SQLite file (needs Node 22.13+).
   All SQL below is portable between the two. */
const path = require('path'), fs = require('fs');
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT UNIQUE, pwd TEXT, gsub TEXT UNIQUE, name TEXT, avatar TEXT, bio TEXT, created BIGINT, pid TEXT)`,
  `CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, ended BIGINT, size INTEGER, win TEXT, val INTEGER, sa INTEGER, sb INTEGER, duration INTEGER, result TEXT)`,
  `CREATE TABLE IF NOT EXISTS match_players(match_id TEXT, user_id TEXT, name TEXT, team TEXT, result TEXT, correct INTEGER, wrong INTEGER, avgms REAL, mvp INTEGER)`,
  `CREATE INDEX IF NOT EXISTS mp_user ON match_players(user_id)`,
  `CREATE TABLE IF NOT EXISTS friends(a TEXT, b TEXT, status TEXT, created BIGINT, PRIMARY KEY(a, b))`,
];
module.exports = async function open() {
  let db;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
    const conv = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
    db = { kind: 'postgres', all: async (s, p = []) => (await pool.query(conv(s), p)).rows, run: async (s, p = []) => { await pool.query(conv(s), p); } };
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const file = process.env.DB_FILE || path.join(__dirname, 'data', 'numberhunt.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    db = { kind: 'sqlite', all: async (s, p = []) => raw.prepare(s).all(...p), run: async (s, p = []) => { raw.prepare(s).run(...p); } };
  }
  for (const s of SCHEMA) await db.run(s);
  try { await db.run('ALTER TABLE users ADD COLUMN pid TEXT'); } catch (e) { /* column already exists */ }   // upgrade older databases
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS users_pid ON users(pid)');
  return db;
};
