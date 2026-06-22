require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query("DELETE FROM articles WHERE description LIKE '%points · %comments on Hacker News%' RETURNING id");
    console.log(`Deleted ${res.rowCount} articles that had fallback stats instead of descriptions.`);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
