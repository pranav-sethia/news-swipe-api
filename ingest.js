require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');
const pool = require('./db');
const { safeFetch, readWithSizeLimit, DEFAULT_MAX_BYTES } = require('./utils/safeFetch');

const { pipeline } = require('@xenova/transformers');

const OG_FETCH_TIMEOUT_MS = 4000;
const IMAGE_CHECK_TIMEOUT_MS = 5000;
// Neither the primary categorization call nor the self-consistency vote calls
// previously had any request timeout at all (unlike extractArticleData's
// safeFetch, which already used a 4000ms AbortController) - a single hung
// Groq response could stall the whole ingestion run indefinitely with zero
// visible error. Found this live: a real batch test appeared to silently
// stop making progress with no console output for 45+ minutes. 30s is
// generous for a real response (observed real calls complete in under 1s)
// but bounds the failure mode to "one retry-able error" instead of "hangs
// forever."
const GROQ_CALL_TIMEOUT_MS = 30000;
const MIN_IMAGE_DIMENSION = 200;
// Calibrated against a real near-black Twitter video-thumbnail placeholder
// (mean ~3) vs. legitimate article images (mean 85-245) - comfortably below
// even a moody/dark real photo, comfortably above a placeholder frame.
const MIN_MEAN_BRIGHTNESS = 30;

// Reject images that are too dark or too small to be a real hero photo,
// rather than let a bad og:image/twitter:image (often a near-black video
// placeholder frame on link-card posts) get stored and shown like a real
// photo. Fails safe to "reject" on any error - an image we couldn't verify
// shouldn't be trusted over the curated fallback textures.
async function isImageGoodQuality(imageUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_CHECK_TIMEOUT_MS);
    const res = await safeFetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;

    const buffer = await readWithSizeLimit(res, DEFAULT_MAX_BYTES);
    const image = sharp(buffer);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width < MIN_IMAGE_DIMENSION || metadata.height < MIN_IMAGE_DIMENSION) {
      return false;
    }

    const stats = await image.stats();
    const channels = stats.channels.slice(0, 3);
    const meanBrightness = channels.reduce((sum, c) => sum + c.mean, 0) / channels.length;
    return meanBrightness >= MIN_MEAN_BRIGHTNESS;
  } catch {
    return false;
  }
}

// Groq's rate limits are tracked per-MODEL, not pooled across an account's
// models (confirmed live: burning down openai/gpt-oss-20b's own budget left
// openai/gpt-oss-120b's and qwen/qwen3.8-27b's remaining-tokens counters
// completely untouched). That's what makes the model split below possible -
// ingestion and routes/comments.js now draw from two fully independent free
// budgets instead of racing each other on one.
//
// Parses Groq's rate-limit duration strings ("607ms", "1.042s", "17m16.8s")
// into milliseconds, for adaptive pacing below.
function parseGroqDurationMs(str) {
  if (!str) return null;
  const match = str.match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (!match) return null;
  const minutes = parseFloat(match[1] || 0);
  const seconds = parseFloat(match[2] || 0);
  const ms = parseFloat(match[3] || 0);
  return minutes * 60000 + seconds * 1000 + ms;
}

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

const ALLOWED_CATEGORIES = ["Software Engineering", "Hardware & Systems", "Artificial Intelligence", "Startups & VC", "Cybersecurity", "Business & Finance", "Science & Space", "Design & UI/UX", "Other"];

// Lightweight category-only vote for self-consistency checking - reuses the
// same TAXONOMY/RULE-1 text as the primary call (kept in sync manually,
// see getSummary) but skips bullets/tags/relevance_flag entirely, so it's not
// meaningfully cheaper than the full call (input tokens - the article text -
// dominate cost either way) but avoids paying for bullet/tag generation we'd
// throw away. Uses a higher temperature than the primary call's 0 specifically
// to get genuine sample diversity - voting with more temp=0 calls would just
// repeat the same answer for no benefit (live-confirmed this session).
async function voteCategory(text, title) {
  const systemPrompt = `You are a precision taxonomy and classification engine for a technology news aggregator. Your task is to analyze the provided text and output a JSON object.`;
  const promptText = `Classify the following text into exactly ONE of the following categories based on its primary theme:

TAXONOMY:
- Software Engineering: Programming languages, web/mobile development, databases, algorithms, DevOps, infrastructure, open-source projects, game development, and software architecture.
- Hardware & Systems: Semiconductors, GPUs, networking, servers, operating systems, embedded systems, robotics, IoT, self-driving technology, and consumer electronics (e.g., Apple hardware).
- Artificial Intelligence: LLMs, machine learning, neural networks, computer vision, data science, NLP, and AI agents. Reserved for articles primarily about the technology, research, or techniques themselves.
- Startups & VC: Early-stage companies, venture capital, fundraising, incubators (like YC), entrepreneurship, founders, and product management.
- Cybersecurity: Vulnerabilities, hacking, zero-days, infosec, privacy laws, encryption (non-crypto), malware, and network security.
- Business & Finance: Corporate acquisitions (M&A), earnings reports, stock market, tech industry economics, Big Tech antitrust/lawsuits, layoffs, FCC/FTC tech regulations, enterprise pricing, and blockchain/cryptocurrency business or regulatory news.
- Science & Space: Physics, biology, biotech, medicine, astronomy, aerospace (e.g., SpaceX), mathematics, climate tech, and energy.
- Design & UI/UX: Typography, frontend aesthetics, user experience research, human-computer interaction (HCI), and web accessibility.
- Other: Any topic that does not clearly and specifically match one of the categories above. This is the default for anything outside technology, science, or business: music, art, food, general or classical history, language and linguistics, personal essays, hobbies, internet culture, and similar. When in doubt between Other and a narrow specific category like Design & UI/UX, prefer Other unless the article is unambiguously and primarily about that specific category's subject matter.

RULES:
1. Determine the PRIMARY theme, not just mentioned keywords. If an article is fundamentally about a company's funding round, valuation, or other early-stage deal mechanics, classify it as Startups & VC, even when the company's product involves AI. If it is fundamentally about an acquisition, earnings, or other corporate/market news, classify it as Business & Finance, even when the company involved is an AI company. Reserve Artificial Intelligence for articles primarily about the technology, research, or techniques themselves, not company or deal news that happens to mention AI.
2. You must provide your step-by-step reasoning BEFORE outputting the final category.`;
  try {
    const voteTimeout = new AbortController();
    const voteTimeoutId = setTimeout(() => voteTimeout.abort(), GROQ_CALL_TIMEOUT_MS);
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: voteTimeout.signal,
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptText + "\n\nTitle: " + title + "\n\nArticle Text:\n" + text.substring(0, 4000) }
        ],
        temperature: 0.35,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'category_vote',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                reasoning: { type: 'string' },
                category: { type: 'string', enum: ALLOWED_CATEGORIES },
              },
              required: ['reasoning', 'category'],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    clearTimeout(voteTimeoutId);
    const rateLimitInfo = {
      remainingTokens: parseInt(res.headers.get('x-ratelimit-remaining-tokens'), 10),
      resetTokensMs: parseGroqDurationMs(res.headers.get('x-ratelimit-reset-tokens')),
    };
    if (!res.ok) return { category: null, rateLimitInfo };
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content.trim());
    const category = ALLOWED_CATEGORIES.includes(parsed.category) ? parsed.category : null;
    return { category, rateLimitInfo };
  } catch {
    return { category: null, rateLimitInfo: null };
  }
}

// Conservative aggregation across the primary call + 2 vote calls' rate-limit
// headers - takes whichever reading shows the LEAST remaining budget, so the
// caller's adaptive pacing (computeAdaptiveDelayMs) accounts for all 3 calls'
// real consumption, not just the primary call's (now-stale) snapshot.
function mostDepleted(...infos) {
  const valid = infos.filter(i => i && Number.isFinite(i.remainingTokens));
  if (!valid.length) return infos.find(Boolean) || null;
  return valid.reduce((min, i) => (i.remainingTokens < min.remainingTokens ? i : min));
}

async function getSummary(text, title) {
  // 200 chars (~30 words) let near-empty scrapes (cookie banners, stub pages) through;
  // 500 is closer to a real minimum paragraph of article content.
  if (!text || text.length < 500) return null;

  try {
    const systemPrompt = `You are a precision taxonomy and classification engine for a technology news aggregator. Your task is to analyze the provided text and output a JSON object.`;
    const promptText = `Classify the following text into exactly ONE of the following categories based on its primary theme:

TAXONOMY:
- Software Engineering: Programming languages, web/mobile development, databases, algorithms, DevOps, infrastructure, open-source projects, game development, and software architecture.
- Hardware & Systems: Semiconductors, GPUs, networking, servers, operating systems, embedded systems, robotics, IoT, self-driving technology, and consumer electronics (e.g., Apple hardware).
- Artificial Intelligence: LLMs, machine learning, neural networks, computer vision, data science, NLP, and AI agents. Reserved for articles primarily about the technology, research, or techniques themselves.
- Startups & VC: Early-stage companies, venture capital, fundraising, incubators (like YC), entrepreneurship, founders, and product management.
- Cybersecurity: Vulnerabilities, hacking, zero-days, infosec, privacy laws, encryption (non-crypto), malware, and network security.
- Business & Finance: Corporate acquisitions (M&A), earnings reports, stock market, tech industry economics, Big Tech antitrust/lawsuits, layoffs, FCC/FTC tech regulations, enterprise pricing, and blockchain/cryptocurrency business or regulatory news.
- Science & Space: Physics, biology, biotech, medicine, astronomy, aerospace (e.g., SpaceX), mathematics, climate tech, and energy.
- Design & UI/UX: Typography, frontend aesthetics, user experience research, human-computer interaction (HCI), and web accessibility.
- Other: Any topic that does not clearly and specifically match one of the categories above. This is the default for anything outside technology, science, or business: music, art, food, general or classical history, language and linguistics, personal essays, hobbies, internet culture, and similar. When in doubt between Other and a narrow specific category like Design & UI/UX, prefer Other unless the article is unambiguously and primarily about that specific category's subject matter.

RULES:
1. Determine the PRIMARY theme, not just mentioned keywords. If an article is fundamentally about a company's funding round, valuation, or other early-stage deal mechanics, classify it as Startups & VC, even when the company's product involves AI. If it is fundamentally about an acquisition, earnings, or other corporate/market news, classify it as Business & Finance, even when the company involved is an AI company. Reserve Artificial Intelligence for articles primarily about the technology, research, or techniques themselves, not company or deal news that happens to mention AI.
2. You must provide your step-by-step reasoning BEFORE outputting the final category.
3. Extract exactly 3 bullet points capturing the article's actual core idea, insight, or news value - what a reader would want to know even without clicking through. Each bullet must add real information beyond the title; never merely restate or lightly reword the title. Avoid pure jargon/spec dumps (a wall of acronyms/numbers with no sense of why they matter) - if a technical detail is central to the news value, briefly frame why it matters, not just what the number is. Avoid vague, generic phrasing that could describe many different articles - be as SPECIFIC to this exact article's actual content as possible. We have a strict UI width limit: bullets MUST NOT exceed 60 characters in total length.
4. To achieve this, write a full grammatical draft sentence first, then condense it into a fragment by dropping ONLY the subject and articles (a, an, the). Never drop a verb, an infinitive marker ("to"), a preposition, or a conjunction that grammatically connects the words you keep - every bullet must still read as a single correct clause once you mentally restore the implied subject and dropped article. A bullet that is just a noun phrase or label with no verb at all (e.g. dropping the verb entirely instead of just the subject) is WRONG, not a valid fragment - it must still assert something happening or being true, not just name a topic. If the draft is still over 60 characters after that, shorten it further by cutting whole low-value words or phrases, never by deleting the connecting words that hold the remaining words together.
   GOOD (specific, correct fragment): "Teaches others to spot bugs by simulating real users"
   BAD (vague AND ungrammatical): "Teaches others spot bugs" / "New bug-finding approach shared"
   GOOD (has a real verb/claim): "Raises funding through circular deals with major partners"
   BAD (bare noun phrase, no verb - just a label): "Circular financing via partner investment deals"
5. Extract 3 highly specific technical tags.
6. Set relevance_flag to 'mismatch' ONLY if the Article Text is clearly about a different, unrelated topic than the Title (e.g. it looks like a rotating example/sample post embedded on a landing page, or unrelated boilerplate) - otherwise 'match', even if the text is merely brief or tangential. Still do your best to summarize whatever the text actually contains even if you set it to 'mismatch'.
7. Write ONLY the bullet content itself. Never include citations, footnotes, bracketed annotations, source markers, or commentary about your own answer or reasoning process.

Rules for bullets: They MUST be grammatically correct sentence fragments containing a real verb (only the subject and articles may be omitted - a bare noun-phrase label with no verb at all is not a valid fragment), MUST capture real, specific content from the article (never a title restatement or generic filler), MUST NOT include citations or meta-commentary, and MUST NOT exceed 60 characters. Never drop a required verb, infinitive, preposition, or conjunction.`;

    if (!process.env.GROQ_API_KEY) {
      throw new Error("Missing GROQ_API_KEY environment variable. Cloud ingestion requires this key.");
    }

    let res, data;
    let retries = 3;
    while (retries > 0) {
      const groqTimeout = new AbortController();
      const groqTimeoutId = setTimeout(() => groqTimeout.abort(), GROQ_CALL_TIMEOUT_MS);
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: groqTimeout.signal,
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // llama-3.1-8b-instant was fully removed from Groq's lineup (not
          // renamed - confirmed live against /v1/models) at some point
          // after this was last touched, which silently broke ingestion:
          // every categorization call failed with "model does not exist,"
          // and this loop's per-article try/catch treated that as a normal
          // skip rather than a hard failure, so the GitHub Actions run kept
          // reporting green while inserting zero new articles for ~12 days.
          //
          // qwen/qwen3.8-27b, not openai/gpt-oss-20b (used by
          // routes/comments.js): since Groq's rate limits are per-model, this
          // gives ingestion its own free budget - 8,000 tokens/min (same as
          // gpt-oss-20b) but 2,000,000 tokens/DAY vs gpt-oss-20b's 200,000 -
          // confirmed live via /docs/rate-limits, matched exactly by live
          // response headers. Live-tested side by side against gpt-oss-20b
          // on this exact prompt (a clean case and a genuinely ambiguous
          // AI-vs-Business&Finance one): identical category decisions,
          // comparably specific bullets, comparable real token cost (~1,700-
          // 1,930/call). Not a reasoning model - no reasoning_effort param.
          model: 'qwen/qwen3.8-27b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: promptText + "\\n\\nTitle: " + title + "\\n\\nArticle Text:\\n" + text.substring(0, 4000) }
          ],
          // temperature 0, not 0.1 - live-tested against real, targeted
          // boundary-case articles (genuinely confusable category pairs):
          // temp=0 alone fully stabilized every case that showed any
          // instability at 0.1, at zero added cost. Self-consistency voting
          // below (voteCategory) catches the rarer residual case where even
          // temp=0 could differ from the "true" better answer.
          temperature: 0,
          // strict:true constrained decoding, not just json_object mode - live-verified
          // against Groq's real API (both this model and openai/gpt-oss-20b support it)
          // that minItems/maxItems on arrays and enum on category are structurally
          // guaranteed, not just requested. Deliberately NOT using maxLength on the
          // bullet strings - live-tested and confirmed it performs a raw character
          // cutoff mid-generation that splits words across array-element boundaries
          // (e.g. "cataleptic" became "...cata" + "leptic..." across two elements) -
          // worse than no constraint. The 60-char limit stays a prompt instruction,
          // backed by truncateAtWordBoundary below.
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'article_classification',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  reasoning: { type: 'string' },
                  category: {
                    type: 'string',
                    enum: [
                      'Software Engineering', 'Hardware & Systems', 'Artificial Intelligence',
                      'Startups & VC', 'Cybersecurity', 'Business & Finance',
                      'Science & Space', 'Design & UI/UX', 'Other',
                    ],
                  },
                  relevance_flag: {
                    type: 'string',
                    enum: ['match', 'mismatch'],
                    description: "Does the Article Text actually describe the subject named in the Title? Set 'mismatch' ONLY if the text is clearly about a different, unrelated topic (e.g. it looks like a rotating example/sample post embedded on a landing page, or unrelated boilerplate) rather than the actual subject of the Title. If the text is merely brief, tangential, or uses the topic as one example among others, that still counts as 'match'.",
                  },
                  tags: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
                  draft_bullets: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
                  bullets: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
                },
                required: ['reasoning', 'category', 'relevance_flag', 'tags', 'draft_bullets', 'bullets'],
                additionalProperties: false,
              },
            },
          },
        })
      });
      clearTimeout(groqTimeoutId);
      data = await res.json();

      if (res.status === 429) {
        const waitMsg = data.error?.message || "";
        // Was double-escaped (\\d instead of \d) inside a regex LITERAL, where
        // \\d matches a literal backslash+d, never a digit - silently never
        // matched real Groq error text ("...try again in 8.223s"), always
        // falling back to the flat 10s default below. Harmless in practice
        // (a sensible fallback), but never actually used Groq's own suggested
        // wait time as intended. Found while investigating an unrelated stall.
        const match = waitMsg.match(/try again in (\d+\.?\d*)s/);
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

    // Adaptive pacing signal for the caller (processArticles): rather than a
    // flat guessed delay between articles (the old 5s guess was ~2.7x too
    // fast for the real ~1,930 avg tokens/call against an 8,000/min budget -
    // live-confirmed by actually hitting 429 five times in one 17-article
    // run), read Groq's own real-time remaining-tokens counter and only wait
    // when actually close to empty, for exactly as long as Groq itself says
    // the window needs to refill.
    const rateLimitInfo = {
      remainingTokens: parseInt(res.headers.get('x-ratelimit-remaining-tokens'), 10),
      resetTokensMs: parseGroqDurationMs(res.headers.get('x-ratelimit-reset-tokens')),
    };

    const responseText = data.choices[0].message.content.trim();
    const parsed = JSON.parse(responseText);

    // The model is instructed to keep bullets under 60 chars ("a strict UI
    // width limit") but a 45-article real sample caught it violating that by
    // 2 chars once (~1% of bullets) - cheap to enforce as a safety net rather
    // than trust the model to always self-comply. Truncate at the nearest
    // word boundary rather than mid-word, since a hard character cut can
    // land inside a word.
    function truncateAtWordBoundary(str, maxLen) {
      if (str.length <= maxLen) return str;
      const cut = str.slice(0, maxLen);
      const lastSpace = cut.lastIndexOf(' ');
      return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
    }

    let validBullets = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 3) : [];
    const summaryLines = validBullets.map(b => {
      let text = truncateAtWordBoundary(b.replace(/^- /, '').trim(), 60);
      return `- ${text}`;
    }).join('\n');

    // Web3 & Crypto was merged into Business & Finance (too small a category to
    // support a reliable ranking signal, see the taxonomy distribution check).
    // The model shouldn't output it anymore given the prompt above, but remap
    // defensively in case it does.
    const primaryCategory = parsed.category === "Web3 & Crypto"
      ? "Business & Finance"
      : (ALLOWED_CATEGORIES.includes(parsed.category) ? parsed.category : "Other");

    // Self-consistency voting: 2 more lightweight category-only calls at a
    // higher temperature (genuine sample diversity, unlike more temp=0 calls
    // which would just repeat the same answer), majority vote against the
    // primary. Catches the rarer residual sampling instability temp=0 alone
    // doesn't - live-tested this session. On a 3-way split with no majority,
    // fall back to the primary (temp=0) call's own category, the single most
    // deterministic sample available.
    const [voteResult1, voteResult2] = await Promise.all([voteCategory(text, title), voteCategory(text, title)]);
    const votes = [primaryCategory, voteResult1.category, voteResult2.category].filter(Boolean);
    const voteCounts = {};
    votes.forEach(v => { voteCounts[v] = (voteCounts[v] || 0) + 1; });
    const [topCategory, topCount] = Object.entries(voteCounts).sort((a, b) => b[1] - a[1])[0];
    const finalCategory = topCount >= 2 ? topCategory : primaryCategory;
    if (finalCategory !== primaryCategory || new Set(votes).size > 1) {
      console.log(`ℹ️ Category vote non-unanimous for "${title}": primary=${primaryCategory}, votes=[${votes.join(', ')}], final=${finalCategory}`);
    }
    const combinedRateLimitInfo = mostDepleted(rateLimitInfo, voteResult1.rateLimitInfo, voteResult2.rateLimitInfo);

    // Same real-sample check caught tags mid-word truncated at a bare 20-char
    // cut ("government surveilla", "spectral power distr") - not currently
    // rendered anywhere in the frontend, but a real, visible defect the
    // moment they are. Same word-boundary fix, slightly more headroom (30
    // chars) since tags run a bit longer than the bullets.
    let validTags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3).map(t => truncateAtWordBoundary(String(t), 30)) : [];
    
    return {
      summary: summaryLines,
      category: finalCategory,
      tags: validTags,
      bullets: parsed.bullets,
      relevanceFlag: parsed.relevance_flag,
      rateLimitInfo: combinedRateLimitInfo
    };
  } catch (error) {
    // Distinguishable from the "not enough text" short-circuit above: this
    // is a REAL Groq/API failure (network, exhausted retries, bad JSON,
    // "model does not exist"), never a legitimate content-quality skip.
    // processArticles uses this distinction to detect a systemic outage
    // (e.g. a future silent model deprecation) instead of letting it hide
    // behind the ordinary per-article skip path, as happened for ~12 days
    // last time.
    console.error(`Error generating summary via Groq:`, error.message);
    return { groqFailed: true };
  }
}

async function scrapeHackerNews() {
  try {
    console.log("Fetching HN top 500 stories from API...");
    const response = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json');
    const top500Ids = response.data;
    
    // Check which ones we already have
    const existingResult = await pool.query('SELECT hn_id FROM articles');
    const existingIds = new Set(existingResult.rows.map(row => String(row.hn_id)));
    
    let newArticles = [];
    
    for (const id of top500Ids) {
      if (newArticles.length >= 20) break; // Cap at 20 new articles to protect Groq 70B token limit
      
      if (existingIds.has(String(id))) continue;
      
      // Fetch details
      const itemRes = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const item = itemRes.data;
      if (!item || item.dead || item.deleted || item.type !== 'story' || !item.url) continue;
      
      newArticles.push({
        hn_id: String(item.id),
        title: item.title,
        url: item.url,
        score: item.score || 0,
        num_comments: item.descendants || 0
      });
    }
    
    console.log(`Extracted ${newArticles.length} completely new articles from the top 500.`);
    return newArticles;
  } catch (error) {
    console.error('Error fetching Hacker News API:', error.message);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
    const response = await safeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = (await readWithSizeLimit(response, DEFAULT_MAX_BYTES)).toString('utf-8');
    const $ = cheerio.load(html);

    let imageUrl = $('meta[property="og:image"]').attr('content');
    if (!imageUrl) {
      imageUrl = $('meta[name="twitter:image"]').attr('content');
    }
    if (imageUrl && !(await isImageGoodQuality(imageUrl))) {
      imageUrl = null;
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

// HN score/comment counts move the most in the first ~72h after posting.
// The main ingest loop only ever INSERTs a story once (see the existsResult
// skip below), so without this those numbers would stay frozen at whatever
// they were at first ingest for the rest of the article's life in the feed.
// Uses the same free, unauthenticated HN item API as scrapeHackerNews - no
// Groq involvement, so no rate-limit interaction.
const REFRESH_WINDOW_HOURS = 72;

async function refreshRecentEngagement() {
  console.log("Refreshing score/comment counts for recent articles...");
  const { rows } = await pool.query(
    `SELECT hn_id FROM articles WHERE published_at > NOW() - INTERVAL '${REFRESH_WINDOW_HOURS} hours'`
  );

  let updated = 0;
  for (const { hn_id } of rows) {
    try {
      const itemRes = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${hn_id}.json`);
      const item = itemRes.data;
      if (!item) continue;
      await pool.query(
        'UPDATE articles SET score = $1, num_comments = $2 WHERE hn_id = $3',
        [item.score || 0, item.descendants || 0, hn_id]
      );
      updated++;
    } catch (error) {
      console.error(`Failed to refresh engagement for hn_id ${hn_id}:`, error.message);
    }
  }
  console.log(`Refreshed engagement for ${updated}/${rows.length} recent articles.`);
}

// Comfortably above the observed max single-call cost (~2,310 tokens) so
// pacing waits BEFORE actually running dry, not after; used to decide
// whether to wait out the rest of Groq's real per-minute window between
// articles, replacing the old flat 5s guess that turned out to be ~2.7x too
// fast for the real ~1,930 avg tokens/call (live-confirmed: hit 429 five
// times in one 17-article run).
const SAFETY_MARGIN_TOKENS = 2600;
const FALLBACK_DELAY_MS = 3000; // used only when a call didn't return real rate-limit headers to pace against

function computeAdaptiveDelayMs(rateLimitInfo) {
  if (!rateLimitInfo || !Number.isFinite(rateLimitInfo.remainingTokens) || !Number.isFinite(rateLimitInfo.resetTokensMs)) {
    return FALLBACK_DELAY_MS;
  }
  if (rateLimitInfo.remainingTokens < SAFETY_MARGIN_TOKENS) {
    return rateLimitInfo.resetTokensMs + 250; // small buffer past the exact reset instant
  }
  return 0; // still comfortably within budget - real per-call latency already spaces requests out
}

async function processArticles() {
  // Counts a REAL Groq/API failure (never a legitimate "text too short to
  // summarize" skip - see getSummary's { groqFailed: true } vs plain null).
  // If nearly every real attempt this run fails, that's a systemic outage
  // (e.g. a deprecated/renamed model) worth failing this GitHub Actions run
  // loudly over, rather than letting it hide behind the ordinary per-article
  // skip path for potentially another ~12 days like last time.
  let groqAttempts = 0;
  let groqFailures = 0;

  try {
    console.log("Starting ingestion process...");

    await refreshRecentEngagement().catch(error => console.error("Error refreshing recent engagement:", error.message));

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
      let rateLimitInfo = null;
      let mismatchSkipped = false;

      const extractedData = await extractArticleData(article.url);
      if (extractedData) {
        const result = await getSummary(extractedData.text, article.title);
        if (result && result.groqFailed) {
          groqAttempts++;
          groqFailures++;
        } else if (result && result.relevanceFlag === 'mismatch') {
          // Not a Groq/API failure - a real, structurally-valid response that
          // self-reported its extracted text doesn't actually match the
          // title (e.g. Readability grabbed a rotating "featured content"
          // block off a thin marketing page instead of the real article).
          // Don't save; this hn_id isn't inserted, so it's simply
          // re-attempted on a future cron run for as long as it stays in
          // HN's top-500 - not a permanent loss.
          groqAttempts++;
          rateLimitInfo = result.rateLimitInfo;
          mismatchSkipped = true;
          console.log(`⚠️ Skipped: possible content/title mismatch (${article.title}) - ${article.url}`);
        } else if (result) {
          groqAttempts++;
          description = result.summary;
          category = result.category;
          tags = JSON.stringify(result.tags);
          readTime = extractedData.readTimeMinutes;
          rateLimitInfo = result.rateLimitInfo;
        }
        imageUrl = extractedData.imageUrl || null;
        if (extractedData.sourceName) sourceName = extractedData.sourceName;
      }

      if (!description) {
        if (!mismatchSkipped) {
          console.log(`⚠️ Skipped: Not enough text to summarize properly or LLM refused (${article.title})`);
        }
        await new Promise(r => setTimeout(r, computeAdaptiveDelayMs(rateLimitInfo)));
        continue;
      }

      const embeddingText = `${article.title} ${description} ${sourceName || ''}`.trim();
      const embedding = await getEmbedding(embeddingText);

      if (!embedding) {
        console.log(`⚠️ Skipped: Failed to generate vector embedding (${article.title})`);
        await new Promise(r => setTimeout(r, computeAdaptiveDelayMs(rateLimitInfo)));
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

      await new Promise(r => setTimeout(r, computeAdaptiveDelayMs(rateLimitInfo)));

    } catch (error) {
      console.error(`❌ Error processing article ${article.hn_id}:`, error.message);
    }
  }

    console.log("Ingestion process complete.");

    if (groqAttempts >= 3 && groqFailures / groqAttempts >= 0.8) {
      console.error(`❌ CRITICAL: ${groqFailures}/${groqAttempts} Groq calls failed this run - this looks like a systemic outage (e.g. a deprecated/renamed model), not ordinary per-article skips. Failing this run loudly instead of reporting a silent success with near-zero real saves.`);
      process.exitCode = 1;
    }
  } finally {
    console.log("Closing DB connection...");
    await pool.end();
  }
}

module.exports = { getSummary, getEmbedding, extractArticleData, computeAdaptiveDelayMs, parseGroqDurationMs };

if (require.main === module) {
  processArticles();
}
