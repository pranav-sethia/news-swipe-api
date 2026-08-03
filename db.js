const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Verify the server certificate against Node's trusted CA store instead of
  // blanket-disabling verification, which left the connection open to MITM.
  ssl: {
    rejectUnauthorized: true,
  },
});

module.exports = pool;
