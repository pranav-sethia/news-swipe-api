// 1. Load environment variables
require('dotenv').config();

const axios = require('axios');
const { Pool } = require('pg');

// 2. Setup GNews and ML API constants
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const ML_API_URL = 'http://127.0.0.1:8000/embed'; // Your Python "Brain"
const CATEGORIES = ['general', 'technology', 'science', 'sports', 'entertainment'];
const ARTICLES_PER_CATEGORY = 50; // We ask for 50, free tier gives ~10

// 3. Setup Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// --- Helper function for delay ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetches the embedding for a given text from our ML service.
 * @param {string} text The text to embed.
 * @returns {Promise<number[]|null>} The vector embedding or null.
 */
const getEmbedding = async (text) => {
  if (!text || text.trim().length === 0) {
    return null;
  }
  try {
    const response = await axios.post(ML_API_URL, { text });
    return response.data.embedding;
  } catch (err) {
    console.error(`Error getting embedding for text: ${text.substring(0, 20)}...`, err.message);
    return null;
  }
};

/**
 * Main function to fetch, process, and ingest articles.
 */
const ingestArticles = async () => {
  console.log('--- Starting data ingestion ---');

  if (!GNEWS_API_KEY) {
    console.error('❌ GNEWS_API_KEY is not set in .env file. Exiting.');
    return;
  }

  let totalProcessedCount = 0;
  const client = await pool.connect();
  console.log('✅ Connected to Azure DB.');

  try {
    for (const category of CATEGORIES) {
      console.log(`\nFetching category: ${category}...`);
      
      const gnewsUrl = `https://gnews.io/api/v4/top-headlines?lang=en&max=${ARTICLES_PER_CATEGORY}&topic=${category}&token=${GNEWS_API_KEY}`;
      let response;
      try {
        response = await axios.get(gnewsUrl);
      } catch (err) {
        if (err.response && err.response.status === 429) {
          console.error(`❌ Rate limit hit for category: ${category}. Stopping ingestion. Try again later.`);
          break; // Stop the loop if we get a 429
        }
        throw err; // Re-throw other errors
      }

      const articles = response.data.articles;

      if (!articles || articles.length === 0) {
        console.log(`No articles found for category: ${category}.`);
        continue;
      }

      console.log(`Found ${articles.length} articles for ${category}.`);
      let categoryProcessedCount = 0;

      for (const article of articles) {
        if (!article.title || !article.image || !article.description) {
          console.warn(`Skipping article with missing data: ${article.url}`);
          continue;
        }

        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await getEmbedding(textToEmbed);

        if (!embedding) {
          console.warn(`Could not get embedding for: ${article.title}`);
          continue;
        }

        const query = `
          INSERT INTO articles 
            (title, description, article_url, image_url, source_name, published_at, embedding)
          VALUES 
            ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (article_url) DO NOTHING;
        `;
        
        const embeddingString = `[${embedding.join(',')}]`; 

        const values = [
          article.title,
          article.description,
          article.url,
          article.image,
          article.source.name,
          article.publishedAt,
          embeddingString,
        ];

        const insertResult = await client.query(query, values);
        if (insertResult.rowCount > 0) {
          categoryProcessedCount++;
        }
      }
      console.log(`Saved ${categoryProcessedCount} new articles for ${category}.`);
      totalProcessedCount += categoryProcessedCount;

      // Wait 2 seconds before fetching the next category to avoid rate limit
      if (category !== CATEGORIES[CATEGORIES.length - 1]) {
         console.log('Waiting 2 seconds to respect GNews rate limit...');
         await sleep(2000); 
      }
    }
  } catch (err) {
    console.error('Error during ingestion process:', err.message);
  } finally {
    client.release();
    console.log('\nReleased DB client.');
  }

  console.log(`\n--- Ingestion Complete ---`);
  console.log(`Processed and saved ${totalProcessedCount} new articles to the database.`);

  await pool.end();
};

// Run the function
ingestArticles();