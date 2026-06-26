require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function wipeDatabase() {
  console.log('🗑 Wiping all articles and swipe history from the database...');
  
  try {
    // TRUNCATE empties the tables. CASCADE ensures that any dependent rows 
    // (like users' swipe records tied to these articles) are also cleared.
    // Note: This does NOT delete User accounts.
    await pool.query('TRUNCATE TABLE user_swipes, articles CASCADE;');
    console.log('✅ Database successfully wiped!');
    console.log('⏳ Run `node ingest.js` to fetch fresh articles with the new summaries.');
  } catch (err) {
    console.error('❌ Error wiping database:', err.message);
  } finally {
    await pool.end();
  }
}

wipeDatabase();
