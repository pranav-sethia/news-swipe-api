require('dotenv').config();
const pool = require('../db');

async function cleanupOldGuests() {
  console.log('Running guest account cleanup job...');
  try {
    // Find guests whose email starts with guest_ AND whose last_active is older than 7 days
    const { rows: staleGuests } = await pool.query(`
      SELECT id FROM users
      WHERE email LIKE 'guest_%@hackerswipe.io'
        AND last_active < NOW() - INTERVAL '7 days'
    `);
    const staleIds = staleGuests.map((u) => u.id);

    if (staleIds.length === 0) {
      console.log('No inactive guest accounts to clean up.');
      return;
    }

    // Their swipes must go first, or the users delete fails on the user_swipes foreign key.
    await pool.query('DELETE FROM user_swipes WHERE user_id = ANY($1)', [staleIds]);
    const res = await pool.query('DELETE FROM users WHERE id = ANY($1) RETURNING id', [staleIds]);
    console.log(`Successfully deleted ${res.rowCount} inactive guest accounts.`);
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    process.exit(0);
  }
}

cleanupOldGuests();
