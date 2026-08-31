require('dotenv').config();
const pool = require('../db');

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

    // Language-based deletion (via the `languagedetect` package) was removed
    // here after live-checking it against real production data: it's an
    // n-gram model that needs real prose to work, and title + 3 terse ~50-
    // char bullet fragments (condensed, jargon-dense, article-specific
    // technical language, not natural sentence structure) isn't enough
    // signal - it confidently misread genuinely English tech articles as
    // French, Spanish, German, Slovak, and even Latin. Measured directly
    // against 5 real recent cron runs: 14 of 57 freshly-saved, correctly-
    // categorized articles (~25%) were being silently deleted minutes after
    // ingestion as false positives - in one run, 9 of 13 (69%). Given HN's
    // content is effectively all English already, the risk of a genuinely
    // non-English article slipping through is far smaller than the harm
    // this was causing.
    for (const article of articles) {
      // Check for lack of description or very short description
      const desc = article.description ? article.description.trim() : '';
      if (!desc || desc.length < 20) {
        toDeleteIds.push(article.id);
        countNoDescription++;
      }
    }

    if (toDeleteIds.length > 0) {
      console.log(`\nFound ${countNoDescription} articles with no/short description.`);
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
