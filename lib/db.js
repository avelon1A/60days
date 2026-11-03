const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solves (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  days JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  d INTEGER NOT NULL,
  p INTEGER NOT NULL,
  t TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solutions (
  day INTEGER PRIMARY KEY,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  name_key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS leetcode TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lc_last_sync BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lc_manual_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lc_status TEXT;
ALTER TABLE solves ADD COLUMN IF NOT EXISTS auto JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS quiz_attempts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  answers JSONB NOT NULL,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  late BOOLEAN NOT NULL DEFAULT FALSE,
  at BIGINT NOT NULL,
  PRIMARY KEY (user_id, day)
);
`;

let runner;
let ready;

export function dbUrl() {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const keys = Object.keys(env).sort().filter(k => /^postgres(ql)?:\/\//.test(env[k] || ""));
  const key = keys.find(k => !/UNPOOLED|NON_POOLING/.test(k)) || keys[0];
  return key ? env[key] : null;
}

export const dbEnvNames = () => Object.keys(process.env).filter(k => /PG|POSTGRES|DATABASE|NEON/.test(k)).sort();

async function makeRunner() {
  const url = dbUrl();
  if (url) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    return {
      query: (text, params = []) => sql(text, params),
      exec: async (text) => { for (const stmt of text.split(";").map(s => s.trim()).filter(Boolean)) await sql(stmt, []); },
    };
  }
  if (process.env.VERCEL) throw new Error("No database connected: add Neon Postgres under Storage in Vercel");
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(process.env.PGLITE_DIR || undefined);
  return {
    query: async (text, params = []) => (await pg.query(text, params)).rows,
    exec: (text) => pg.exec(text),
  };
}

export async function db() {
  if (!ready) {
    ready = (async () => {
      runner = await makeRunner();
      await runner.exec(SCHEMA);
      return runner;
    })();
  }
  return ready;
}

export async function q(text, params) {
  const r = await db();
  return r.query(text, params);
}
