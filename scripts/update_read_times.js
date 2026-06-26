require('dotenv').config({ path: '/Users/prandog/Desktop/news-swipe-project/news-swipe-api/.env' });
const { Pool } = require('pg');
const axios = require('axios');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log("Fetching top 30 recent articles...");
    const res = await pool.query('SELECT id, article_url, title FROM articles ORDER BY published_at DESC LIMIT 30');
    const articles = res.rows;
    
    for (const article of articles) {
      if (article.article_url.includes('news.ycombinator.com')) continue;
      
      try {
        console.log(`Processing: ${article.title}`);
        const response = await axios.get(article.article_url, { 
          timeout: 5000,
          headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        
        const doc = new JSDOM(response.data, { url: article.article_url });
        const reader = new Readability(doc.window.document);
        const articleData = reader.parse();
        
        if (articleData && articleData.textContent) {
          const textContent = articleData.textContent.replace(/\s+/g, ' ').trim();
          const wordCount = textContent.split(/\s+/).length;
          const readTimeMinutes = Math.max(1, Math.ceil(wordCount / 225));
          
          await pool.query('UPDATE articles SET read_time_minutes = $1 WHERE id = $2', [readTimeMinutes, article.id]);
          console.log(` -> Updated to ${readTimeMinutes} mins (Word count: ${wordCount})`);
        } else {
          console.log(` -> Readability failed, keeping old time.`);
        }
      } catch (e) {
        console.log(` -> Error fetching ${article.article_url}: ${e.message}`);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
