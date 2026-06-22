require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const { pipeline } = require('@xenova/transformers');

const OG_FETCH_TIMEOUT_MS = 4000;

// Initialize Postgres Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let extractor;
async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractor;
}

async function getEmbedding(text) {
  try {
    const ext = await getExtractor();
    const output = await ext(text, { pooling: 'mean', normalize: true });
    return `[${Array.from(output.data).join(',')}]`;
  } catch (error) {
    console.error('Error generating embedding:', error);
    return null;
  }
}

async function getSummary(text) {
  if (!text || text.length < 200) return null;

  try {
    const systemPrompt = `You are a strict data extraction tool. You must output exactly in this format:
CATEGORY: [Exact Category Name]
- [Bullet 1]
- [Bullet 2]
- [Bullet 3]

Categories MUST be exactly one of: Artificial Intelligence, Software Engineering, Hardware & Systems, Startups & VC, Cybersecurity, Business & Finance, Science & Space, Design & UI/UX, Web3 & Crypto, Other.`;
    const prompt = `Extract 1 category and 3 critical facts from the text below.\nRules:\n1. Start each point with a dash (-).\n2. Keep each point strictly UNDER 12 WORDS.\n3. Output NOTHING else.\n\nText:\n${text.substring(0, 4000)}`;

    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', system: systemPrompt, prompt: prompt, stream: false })
    });
    const data = await res.json();
    const responseText = data.response.trim();
    
    const lower = responseText.toLowerCase();
    if (lower.includes("cannot be fulfilled") || lower.includes("insufficient") || lower.includes("unable to extract") || lower.includes("cannot fulfill")) {
      return null;
    }

    const lines = responseText.split('\n').filter(l => l.trim().length > 0);
    let category = "Other";
    let summaryLines = [];
    
    for (let line of lines) {
      if (line.toUpperCase().startsWith("CATEGORY:")) {
        category = line.substring(9).trim();
      } else if (line.startsWith("-")) {
        summaryLines.push(line);
      }
    }
    
    return { summary: summaryLines.join('\n'), category };
  } catch (error) {
    console.error(`Error generating summary via Ollama:`, error.message);
    return null;
  }
}

async function scrapeHackerNews() {
  try {
    console.log("Fetching HN front page...");
    const response = await axios.get('https://news.ycombinator.com/');
    const $ = cheerio.load(response.data);

    let articles = [];

    $('.athing').each((index, element) => {
      const id = $(element).attr('id');
      const titleElement = $(element).find('.titleline > a').first();
      const title = titleElement.text().trim();
      const url = titleElement.attr('href');
      
      const subtext = $(element).next().find('.subtext');
      const scoreText = subtext.find('.score').text();
      const score = scoreText ? parseInt(scoreText.replace(/\D/g, '')) : 0;
      
      const commentsText = subtext.find('a').last().text();
      const commentsMatch = commentsText.match(/(\d+)\s*comment/);
      const numComments = commentsMatch ? parseInt(commentsMatch[1]) : 0;
      
      let articleUrl = url;
      if (articleUrl && articleUrl.startsWith('item?id=')) {
        articleUrl = `https://news.ycombinator.com/${articleUrl}`;
      }

      if (title && articleUrl) {
        articles.push({
          hn_id: id,
          title,
          url: articleUrl,
          score,
          num_comments: numComments
        });
      }
    });

    console.log(`Extracted ${articles.length} articles from front page.`);
    return articles;
  } catch (error) {
    console.error('Error fetching Hacker News:', error.message);
    return [];
  }
}

async function extractArticleData(url) {
  if (url.includes('news.ycombinator.com')) {
    return null; 
  }

  try {
    const response = await axios.get(url, { 
      timeout: OG_FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    const html = response.data;
    const $ = cheerio.load(html);

    let imageUrl = $('meta[property="og:image"]').attr('content');
    if (!imageUrl) {
      imageUrl = $('meta[name="twitter:image"]').attr('content');
    }

    let sourceName = $('meta[property="og:site_name"]').attr('content');
    if (!sourceName) {
      try {
        const urlObj = new URL(url);
        sourceName = urlObj.hostname.replace(/^www\./, '');
      } catch (e) {}
    }

    $('script, style, nav, footer, header, aside, iframe, noscript').remove();
    let textContent = $('body').text().replace(/\s+/g, ' ').trim();

    return { imageUrl: imageUrl || null, sourceName: sourceName || null, text: textContent };
  } catch (error) {
    return null;
  }
}

async function processArticles() {
  console.log("Starting ingestion process...");
  
  const articles = await scrapeHackerNews();
  
  for (const article of articles) {
    try {
      const existsResult = await pool.query('SELECT id FROM articles WHERE hn_id = $1', [article.hn_id]);
      if (existsResult.rows.length > 0) {
        console.log(`Skipping existing article: ${article.title}`);
        continue;
      }

      console.log(`Processing new article: ${article.title}`);

      let description = null;
      let category = null;
      let imageUrl = null;
      let sourceName = null;
      
      try {
        const urlObj = new URL(article.url);
        sourceName = urlObj.hostname.replace(/^www\./, '');
      } catch (e) {}

      const extractedData = await extractArticleData(article.url);
      if (extractedData) {
        const result = await getSummary(extractedData.text);
        if (result) {
          description = result.summary;
          category = result.category;
        }
        imageUrl = extractedData.imageUrl || null;
        if (extractedData.sourceName) sourceName = extractedData.sourceName;
      }

      if (!description) {
        console.log(`⚠️ Skipped: Not enough text to summarize properly or LLM refused (${article.title})`);
        continue;
      }

      const embeddingText = `${article.title} ${description} ${sourceName || ''}`.trim();
      const embedding = await getEmbedding(embeddingText);

      await pool.query(
        `INSERT INTO articles (hn_id, title, article_url, image_url, source_name, published_at, score, num_comments, description, embedding, category)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10)`,
        [
          article.hn_id,
          article.title,
          article.url,
          imageUrl,
          sourceName,
          article.score,
          article.num_comments,
          description,
          embedding,
          category
        ]
      );
      
      console.log(`✅ Saved: ${article.title}`);
    } catch (error) {
      console.error(`❌ Error processing article ${article.hn_id}:`, error.message);
    }
  }

  console.log("Ingestion process complete.");
  pool.end();
}

processArticles();
