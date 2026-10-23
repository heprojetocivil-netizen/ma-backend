const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS affiliates (
        nick TEXT PRIMARY KEY,
        coins_pending INTEGER DEFAULT 0,
        coins_confirmed INTEGER DEFAULT 0,
        coins_paid INTEGER DEFAULT 0,
        bonus_given INTEGER DEFAULT 0,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        ref_nick TEXT NOT NULL,
        buyer_nick TEXT,
        payment_id TEXT,
        coins INTEGER DEFAULT 5,
        status TEXT DEFAULT 'pending',
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        confirmed_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS pre_vendas (
        id SERIAL PRIMARY KEY,
        ref_nick TEXT NOT NULL,
        buyer_nick TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        used INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        nick TEXT NOT NULL,
        coins INTEGER NOT NULL,
        pix_key TEXT NOT NULL,
        pix_type TEXT NOT NULL,
        status TEXT DEFAULT 'requested',
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        paid_at BIGINT
      );
    `);
    console.log('DB pronto.');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
