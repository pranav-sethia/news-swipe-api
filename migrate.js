require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  console.log('Running schema migration...');
  try {
    await client.query(`
      ALTER TABLE articles
        ADD COLUMN IF NOT EXISTS score INTEGER,
        ADD COLUMN IF NOT EXISTS num_comments INTEGER,
        ADD COLUMN IF NOT EXISTS hn_id VARCHAR(32);
    `);
    console.log('✅ Columns score, num_comments, hn_id added (or already existed).');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    client.release();
    pool.end();
  }
}

run();
