/**
 * update_scores.js
 * 
 * Efficiently updates score and num_comments for all articles ingested in the last 7 days.
 * Uses the official HackerNews Firebase API to get the exact final tally for recent articles.
 */
require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  console.log('✅ Connected to database.\n');

  try {
    // Fetch all articles from the last 7 days that have an hn_id
    console.log('🔄 Fetching recent articles from the database...');
    const result = await client.query(`
      SELECT hn_id, title 
      FROM articles 
      WHERE published_at > NOW() - INTERVAL '7 days' 
        AND hn_id IS NOT NULL
    `);
    
    const articles = result.rows;
    console.log(`   Found ${articles.length} articles from the last 7 days.\n`);

    let updated = 0;
    
    // Process in batches of 10 to avoid overwhelming the network
    const BATCH_SIZE = 10;
    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
      const batch = articles.slice(i, i + BATCH_SIZE);
      
      const promises = batch.map(async (article) => {
        try {
          const { data } = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${article.hn_id}.json`);
          if (data) {
            const score = data.score || 0;
            const comments = data.descendants || 0;
            
            await client.query(
              `UPDATE articles SET score = $1, num_comments = $2 WHERE hn_id = $3`,
              [score, comments, article.hn_id]
            );
            return { title: article.title, score, comments, success: true };
          }
        } catch (err) {
          return { success: false };
        }
        return { success: false };
      });

      const results = await Promise.all(promises);
      
      for (const res of results) {
        if (res.success) {
          console.log(`✅ Updated: "${res.title?.substring(0, 50)}..." → ${res.score}pts / ${res.comments} comments`);
          updated++;
        }
      }
      
      // Small delay between batches
      if (i + BATCH_SIZE < articles.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    console.log(`\n--- Done ---`);
    console.log(`✅ Successfully synced exact scores for ${updated} articles.`);

  } finally {
    client.release();
    pool.end();
  }
}

run().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
