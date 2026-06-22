require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fix() {
  const mapping = {
    'Artificial Intelligence': ['AI', 'AI Magazine'],
    'Science & Space': ['Space & Astronomy', 'Space & Technology', 'Environmental Research', 'Solar power', 'Biomedical News', 'Health', 'Education & Science', 'History & Science'],
    'Cybersecurity': ['Security & Cybersecurity', 'Kernel Security', 'Computer Systems Security', 'OpenBSD & Security', 'Social Engineering'],
    'Software Engineering': ['GitHub', 'OpenTelemetry', 'Computer Science', 'Bug', 'Symbolic Computation', 'Signal Processing', 'Linux/m68k', 'FreeCAD'],
    'Hardware & Systems': ['Consumer Electronics', 'Consumer Electronics News', 'Computer Engineering'],
    'Design & UI/UX': ['Art & Design', 'Human-Computer Interaction', 'Architecture'],
    'Business & Finance': ['Marketing']
  };

  for (const [target, sources] of Object.entries(mapping)) {
    for (const source of sources) {
      await pool.query('UPDATE articles SET category = $1 WHERE category = $2', [target, source]);
    }
  }

  const valid = [
    'Software Engineering', 'Hardware & Systems', 'Artificial Intelligence', 
    'Startups & VC', 'Cybersecurity', 'Business & Finance', 'Science & Space', 
    'Design & UI/UX', 'Web3 & Crypto', 'Other'
  ];

  // Anything else goes to 'Other'
  await pool.query(`UPDATE articles SET category = 'Other' WHERE category != ALL($1::text[])`, [valid]);

  // Fix known hallucinations in Web3 & Crypto
  await pool.query(`
    UPDATE articles 
    SET category = 'Software Engineering' 
    WHERE category = 'Web3 & Crypto' 
    AND (tags::text ILIKE '%DOS%' OR tags::text ILIKE '%React%' OR tags::text ILIKE '%Linux%' OR tags::text ILIKE '%Mac%')
    AND tags::text NOT ILIKE '%crypto%' AND tags::text NOT ILIKE '%bitcoin%'
  `);

  console.log("Categories fixed!");
  pool.end();
}
fix();
