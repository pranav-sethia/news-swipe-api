require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  console.log('Connecting to DB to clean up old articles...');
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM user_swipes WHERE article_id IN (SELECT id FROM articles WHERE source_name != 'Hacker News')");
    const result = await client.query("DELETE FROM articles WHERE source_name != 'Hacker News'");
    console.log(`✅ Successfully deleted ${result.rowCount} old GNews articles!`);
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    pool.end();
  }
}

run();
