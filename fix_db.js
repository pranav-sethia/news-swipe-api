require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('ALTER TABLE user_swipes ALTER COLUMN liked DROP NOT NULL;')
  .then(() => { console.log('Dropped NOT NULL constraint on liked column'); process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
