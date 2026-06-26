require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cheerio = require('cheerio');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function extractReadTime(url) {
  if (url.includes('news.ycombinator.com')) {
    return null; 
  }

  try {
    const response = await axios.get(url, { 
      timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    const html = response.data;
    const $ = cheerio.load(html);

    const doc = new JSDOM(html, { url });
    const reader = new Readability(doc.window.document);
    const articleData = reader.parse();
    
    let textContent = "";
    if (articleData && articleData.textContent) {
      textContent = articleData.textContent;
    } else {
      let pTexts = [];
      $('p').each((i, el) => pTexts.push($(el).text()));
      textContent = pTexts.join(' ');
    }
    
    textContent = textContent.replace(/\s+/g, ' ').trim();
    const wordCount = textContent.split(/\s+/).length;
    return Math.max(1, Math.ceil(wordCount / 225));
  } catch (error) {
    return null;
  }
}

async function runMigration() {
  console.log('Fetching existing articles...');
  const res = await pool.query('SELECT id, title, article_url, read_time_minutes FROM articles');
  const articles = res.rows;
  
  console.log(`Found ${articles.length} articles to update.`);
  
  let updatedCount = 0;
  
  // Process sequentially to avoid blowing up memory/network
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    console.log(`[${i+1}/${articles.length}] Processing: ${article.title}`);
    
    const readTime = await extractReadTime(article.article_url);
    if (readTime) {
      await pool.query('UPDATE articles SET read_time_minutes = $1 WHERE id = $2', [readTime, article.id]);
      console.log(`  -> Updated to ${readTime} min (was ${article.read_time_minutes} min)`);
      updatedCount++;
    } else {
      console.log(`  -> Skipped (could not extract)`);
    }
  }
  
  console.log(`\\nMigration complete. Successfully updated ${updatedCount} articles.`);
  process.exit(0);
}

runMigration().catch(console.error);
