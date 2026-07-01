require('dotenv').config();
const { Pool } = require('pg');
const LanguageDetect = require('languagedetect');

const lngDetector = new LanguageDetect();
lngDetector.setLanguageType('iso2'); // e.g. 'en'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runCleanup() {
  const client = await pool.connect();
  try {
    console.log("Fetching all articles...");
    const { rows: articles } = await client.query('SELECT id, title, description FROM articles');
    console.log(`Found ${articles.length} total articles.`);

    console.log("\nDeleting articles older than 90 days...");
    const deleteSwipesRes = await client.query("DELETE FROM user_swipes WHERE article_id IN (SELECT id FROM articles WHERE created_at < NOW() - INTERVAL '90 days')");
    console.log(`Deleted ${deleteSwipesRes.rowCount} associated user swipes.`);
    const deleteRes = await client.query("DELETE FROM articles WHERE created_at < NOW() - INTERVAL '90 days'");
    console.log(`Deleted ${deleteRes.rowCount} old articles.`);

    const toDeleteIds = [];
    let countNoDescription = 0;
    let countNonEnglish = 0;

    for (const article of articles) {
      // 1. Check for lack of description or very short description
      const desc = article.description ? article.description.trim() : '';
      if (!desc || desc.length < 20) {
        toDeleteIds.push(article.id);
        countNoDescription++;
        continue;
      }

      // 2. Check language
      // We will test language on title + description to be safe. 
      // Sometimes content is HTML or very short, but title+desc is usually a good indicator.
      const textToAnalyze = `${article.title} ${desc}`.trim();
      const detectedLangs = lngDetector.detect(textToAnalyze, 3);
      
      let isEnglish = false;
      if (detectedLangs.length === 0) {
        // If it can't detect, it might be just a short string of names. We'll give it the benefit of the doubt
        // unless we want to be strict. Let's be lenient.
        isEnglish = true; 
      } else {
        // Check if English is the top detected language, or at least in the top 3 with a decent score
        const topLang = detectedLangs[0][0];
        if (topLang === 'en') {
          isEnglish = true;
        } else {
          // If english is in top 3 but very close score to top, maybe it's mixed.
          // But usually top language is the main one.
          isEnglish = false;
        }
      }

      if (!isEnglish) {
        toDeleteIds.push(article.id);
        countNonEnglish++;
        console.log(`[Non-English] ${article.title} (Detected: ${detectedLangs[0] ? detectedLangs[0][0] : 'none'})`);
      }
    }

    if (toDeleteIds.length > 0) {
      console.log(`\nFound ${countNoDescription} articles with no/short description.`);
      console.log(`Found ${countNonEnglish} non-English articles.`);
      console.log(`Deleting a total of ${toDeleteIds.length} articles...`);

      // Deleting in chunks to avoid blowing up the query parameter limit
      const chunkSize = 100;
      for (let i = 0; i < toDeleteIds.length; i += chunkSize) {
        const chunk = toDeleteIds.slice(i, i + chunkSize);
        await client.query('DELETE FROM user_swipes WHERE article_id = ANY($1)', [chunk]);
        await client.query('DELETE FROM articles WHERE id = ANY($1)', [chunk]);
      }
      console.log("✅ Cleanup complete!");
    } else {
      console.log("No articles needed to be deleted.");
    }

  } catch (err) {
    console.error("Error during cleanup:", err);
  } finally {
    client.release();
    pool.end();
  }
}

runCleanup();
