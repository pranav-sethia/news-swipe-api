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
    const systemPrompt = `You are an expert data extraction algorithm. You ONLY output valid JSON. Do not include any conversational text.`;
    const promptText = `Analyze the following text and extract exactly 3 bullet points (under 12 words each), 1 category from the list [Software Engineering, Hardware & Systems, Artificial Intelligence, Startups & VC, Cybersecurity, Business & Finance, Science & Space, Design & UI/UX, Web3 & Crypto, Other], and 3 highly specific technical tags (e.g., specific framework names, noun phrases, no stop words, e.g. "React 19" instead of "react19").
    
CRITICAL CATEGORIZATION RULES:
1. "Business & Finance" or "Startups & VC" takes precedence over specific tech categories if the primary focus of the article is acquisitions, funding rounds, stock market moves, corporate pricing strategies, or business restructuring (e.g., "Meta buys AI startup" -> Business & Finance or Startups & VC, NOT Artificial Intelligence. "Micron locks in high memory prices" -> Business & Finance).
2. Only use "Other" for articles about random internet culture, food, lifestyle, DIY, history, or completely non-tech/non-business topics. Do not use "Other" for tech-adjacent corporate news.
  
JSON Schema:
{
  "reasoning": "string (briefly explain why the category fits the text based on the rules)",
  "category": "string",
  "tags": ["string", "string", "string"],
  "bullets": ["string", "string", "string"]
}`;

    if (!process.env.GROQ_API_KEY) {
      throw new Error("Missing GROQ_API_KEY environment variable. Cloud ingestion requires this key.");
    }

    let res, data;
    let retries = 3;
    while (retries > 0) {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
          model: 'llama-3.3-70b-versatile', 
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: promptText + "\\n\\nText:\\n" + text.substring(0, 4000) }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        })
      });
      data = await res.json();
      
      if (res.status === 429) {
        const waitMsg = data.error?.message || "";
        const match = waitMsg.match(/try again in (\\d+\\.?\\d*)s/);
        const waitSeconds = match ? parseFloat(match[1]) : 10;
        console.log(`⏳ Groq Rate Limit Hit. Waiting ${waitSeconds.toFixed(1)} seconds...`);
        await new Promise(r => setTimeout(r, (waitSeconds + 0.5) * 1000));
        retries--;
        continue;
      }
      
      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to fetch from Groq');
      }
      break;
    }
    
    if (!res || !res.ok) {
      throw new Error("Exhausted retries for Groq API");
    }
    
    const responseText = data.choices[0].message.content.trim();
    const parsed = JSON.parse(responseText);
    
    let validBullets = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 3) : [];
    const summaryLines = validBullets.map(b => {
      let text = b.replace(/^- /, '').trim();
      let words = text.split(/\s+/);
      if (words.length > 12) {
        text = words.slice(0, 12).join(' ') + '...';
      }
      return `- ${text}`;
    }).join('\n');

    const allowedCategories = ["Software Engineering", "Hardware & Systems", "Artificial Intelligence", "Startups & VC", "Cybersecurity", "Business & Finance", "Science & Space", "Design & UI/UX", "Web3 & Crypto", "Other"];
    const finalCategory = allowedCategories.includes(parsed.category) ? parsed.category : "Other";
    
    let validTags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3).map(t => String(t).substring(0, 20)) : [];
    
    return {
      summary: summaryLines,
      category: finalCategory,
      tags: validTags,
      bullets: parsed.bullets
    };
  } catch (error) {
    console.error(`Error generating summary via Groq:`, error.message);
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

const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

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
    const readTimeMinutes = Math.max(1, Math.ceil(wordCount / 225));

    return { imageUrl: imageUrl || null, sourceName: sourceName || null, text: textContent, readTimeMinutes };
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
      let tags = null;
      let readTime = null;
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
          tags = JSON.stringify(result.tags);
          readTime = extractedData.readTimeMinutes;
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

      if (!embedding) {
        console.log(`⚠️ Skipped: Failed to generate vector embedding (${article.title})`);
        continue;
      }

      await pool.query(
        `INSERT INTO articles (hn_id, title, article_url, image_url, source_name, published_at, score, num_comments, description, embedding, category, tags, read_time_minutes)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12)`,
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
          category,
          tags,
          readTime
        ]
      );
      
      console.log(`✅ Saved: ${article.title}`);
    } catch (error) {
      console.error(`❌ Error processing article ${article.hn_id}:`, error.message);
    }
  }

  // --- AUTO-REPAIR BLOCK ---
  console.log("Starting auto-repair of flagged articles...");
  try {
    const suspectResult = await pool.query(`
      SELECT id, title, article_url, source_name 
      FROM articles 
      WHERE category = 'REPROCESS'
      LIMIT 5
    `);

    for (const article of suspectResult.rows) {
      console.log(`Auto-repairing article: ${article.title}`);
      
      const extractedData = await extractArticleData(article.article_url);
      if (extractedData) {
        const result = await getSummary(extractedData.text);
        if (result) {
          const newDesc = result.summary;
          const newCat = result.category;
          const newTags = JSON.stringify(result.tags);
          
          const embeddingText = `${article.title} ${newDesc} ${extractedData.sourceName || article.source_name || ''}`.trim();
          const newEmbedding = await getEmbedding(embeddingText);
          
          if (newEmbedding) {
            await pool.query(
              `UPDATE articles 
               SET description = $1, category = $2, tags = $3, embedding = $4, read_time_minutes = $5 
               WHERE id = $6`,
              [newDesc, newCat, newTags, newEmbedding, extractedData.readTimeMinutes, article.id]
            );
            console.log(`✅ Repaired: ${article.title} -> ${newCat}`);
            continue;
          }
        }
      }
      // If any step fails (e.g. 404 URL, LLM fail), clear the flag by dumping it into 'Other' so it doesn't loop forever
      console.log(`⚠️ Failed to repair: ${article.title} - Setting category to 'Other' to clear flag.`);
      await pool.query(`UPDATE articles SET category = 'Other' WHERE id = $1`, [article.id]);
    }
  } catch (err) {
    console.error("Error during auto-repair:", err.message);
  }

  console.log("Ingestion process complete.");
  pool.end();
}

processArticles();
