const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query('SELECT COUNT(*) FROM articles WHERE embedding IS NOT NULL');
    console.log('Embedded Articles Count:', res.rows[0].count);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
