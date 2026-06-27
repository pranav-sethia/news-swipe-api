require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function cleanupOldGuests() {
  console.log('Running guest account cleanup job...');
  try {
    // Delete any users whose email starts with guest_ AND whose last_active is older than 7 days
    const query = `
      DELETE FROM users 
      WHERE email LIKE 'guest_%@hackerswipe.io' 
      AND last_active < NOW() - INTERVAL '7 days'
      RETURNING id;
    `;
    const res = await pool.query(query);
    console.log(`Successfully deleted ${res.rowCount} inactive guest accounts.`);
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    process.exit(0);
  }
}

cleanupOldGuests();
