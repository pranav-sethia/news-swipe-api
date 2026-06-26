require('dotenv').config({ path: '/Users/prandog/Desktop/news-swipe-project/news-swipe-api/.env' });
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query('SELECT title, read_time_minutes FROM articles WHERE read_time_minutes IS NOT NULL LIMIT 10');
    console.log("Sample:", res.rows);
    
    const stats = await pool.query('SELECT MIN(read_time_minutes), MAX(read_time_minutes), AVG(read_time_minutes) FROM articles WHERE read_time_minutes IS NOT NULL');
    console.log("Stats:", stats.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
