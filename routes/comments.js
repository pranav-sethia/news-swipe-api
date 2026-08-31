const express = require('express');
const axios = require('axios');
const pool = require('../db');
const { summaryPerUserLimiter, reserveGroqSummarySlot, apiActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// GET /api/comments/:hnId/raw - proxies the raw comment thread server-side.
// The frontend used to call hn.algolia.com directly from the browser - the
// only data call in the app that bypassed this backend. Same response shape
// (top-level `children`) so CommentsDrawer.jsx's existing parsing logic is
// unchanged, just pointed at this route instead.
router.get('/api/comments/:hnId/raw', apiActionLimiter, async (req, res) => {
  const { hnId } = req.params;
  if (!/^\d+$/.test(hnId)) {
    return res.status(400).json({ error: 'Invalid hnId' });
  }
  try {
    const algoliaRes = await axios.get(`https://hn.algolia.com/api/v1/items/${hnId}`);
    res.json({ children: algoliaRes.data.children || [] });
  } catch (err) {
    console.error(`Error fetching raw comments for hnId ${hnId}:`, err.message);
    res.status(502).json({ error: 'Failed to fetch comments' });
  }
});

// GET /api/comments/:hnId/summary - Summarize Hacker News comments using Groq
// authMiddleware isn't listed here, it's already applied to the whole /api prefix in index.js.
router.get('/api/comments/:hnId/summary', summaryPerUserLimiter, async (req, res) => {
  const { hnId } = req.params;

  if (!/^\d+$/.test(hnId)) {
    return res.status(400).json({ error: 'Invalid hnId' });
  }

  if (req.user && req.user.email && req.user.email.startsWith('guest_')) {
    return res.status(402).json({ error: 'guest_restricted', message: 'Please create an account to use this feature.' });
  }

  try {
    const cacheRes = await pool.query(
      `SELECT comments_summary, summary_generated_at FROM articles WHERE hn_id = $1`,
      [hnId]
    );
    if (cacheRes.rows.length > 0) {
      const row = cacheRes.rows[0];
      if (row.comments_summary && row.summary_generated_at) {
        const hoursSince = (new Date() - new Date(row.summary_generated_at)) / (1000 * 60 * 60);
        if (hoursSince < 24) {
          return res.json({ status: 'success', summary: row.comments_summary });
        }
      }
    }

    let data;
    try {
      const algoliaRes = await axios.get(`https://hn.algolia.com/api/v1/items/${hnId}`);
      data = algoliaRes.data;
    } catch (algoliaErr) {
      if (algoliaErr.response && algoliaErr.response.status === 404) {
        return res.json({ status: 'insufficient', message: 'This article is too new. Comments are still being indexed by our search provider. Please try again shortly.' });
      }
      throw algoliaErr;
    }

    let extractedText = "";
    let commentCount = 0;

    const extractComments = (children) => {
      if (!children || children.length === 0) return;
      for (const child of children) {
        if (commentCount >= 20) return;
        if (child.text) {
          const plainText = child.text.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
          extractedText += `User ${child.author}: ${plainText}\n`;
          commentCount++;
        }
        extractComments(child.children);
      }
    };

    extractComments(data.children);

    if (commentCount < 3 || extractedText.length < 200) {
      return res.json({ status: 'insufficient', message: 'Not enough comments to generate a meaningful consensus.' });
    }

    const systemPrompt = `You are an expert summarizer. Analyze the provided Hacker News comment thread. Identify and completely ignore tangential, pedantic, or off-topic arguments. Focus your summary strictly on the core discussion regarding the main article.

RULES:
1. If the community is overwhelmingly positive and there are no notable criticisms, return an empty array [] for criticisms.
2. Be extremely concise. Keep takeaways to a single sentence each.
3. Write ONLY the summary content itself. Never include citations, footnotes, bracketed annotations, source markers, or commentary about your own answer or reasoning process.`;

    if (!process.env.GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

    if (!reserveGroqSummarySlot()) {
      return res.status(429).json({ error: 'rate_limited', message: 'AI summaries are in high demand right now. Please try again in a minute.' });
    }

    const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      // llama-3.1-8b-instant was fully removed from Groq (see ingest.js for
      // the full story) - openai/gpt-oss-20b + reasoning_effort: 'low' is
      // the tested replacement, ~1,050 tokens for a realistic thread here.
      model: 'openai/gpt-oss-20b',
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: "Comment Thread:\n" + extractedText.substring(0, 6000) }
      ],
      temperature: 0.2,
      // strict:true constrained decoding (live-verified against Groq's real API to
      // work for this model) - directly, structurally prevents the malformed-array
      // bug below by making an array with more than 3 elements impossible to
      // generate, rather than only detecting it after the fact via sanitization.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'comment_summary',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              consensus: { type: 'string' },
              takeaways: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
              criticisms: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 3 },
            },
            required: ['consensus', 'takeaways', 'criticisms'],
            additionalProperties: false,
          },
        },
      },
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      // Found live while debugging an unrelated stall in ingest.js: this call
      // had no request timeout at all, same gap. Here it's worse - a hung
      // Groq response would leave a real user's HTTP request hanging
      // indefinitely instead of just delaying a background cron run.
      timeout: 30000,
    });

    const responseText = groqRes.data.choices[0].message.content.trim();
    const parsed = JSON.parse(responseText);

    // Live testing (10 real threads) caught a real ~20% failure mode: the
    // model sometimes fails to close the "takeaways" array before starting
    // "criticisms", spilling stray fragments into it - e.g. [...3 real
    // takeaways, "Criticisms", ":", []] or a criticism buried in a trailing
    // nested array. Rather than trying to cleverly recover buried content
    // from an already-malformed structure (fragile), sanitize to the
    // intended shape: only real, non-trivial strings, capped at 3 - this
    // fully absorbs both observed malformations, since the garbage always
    // appeared after the legitimate items.
    // Also strips an occasional leaked schema-label prefix the model
    // sometimes echoes into the text itself (e.g. "Criticism 1: ...",
    // "Point 2: ..."), caught live in this same sample.
    const sanitizeStringArray = (arr) => (Array.isArray(arr) ? arr : [])
      .filter(item => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim().replace(/^(criticism|point|takeaway)\s*\d*\s*:\s*/i, ''))
      .slice(0, 3);
    const sanitized = {
      consensus: typeof parsed.consensus === 'string' ? parsed.consensus.trim() : '',
      takeaways: sanitizeStringArray(parsed.takeaways),
      criticisms: sanitizeStringArray(parsed.criticisms),
    };

    await pool.query(
      `UPDATE articles SET comments_summary = $1, summary_generated_at = NOW() WHERE hn_id = $2`,
      [sanitized, hnId]
    );

    res.json({ status: 'success', summary: sanitized });
  } catch (err) {
    if (err.response) {
      if (err.response.status === 429) {
        return res.status(429).json({ error: 'rate_limited', message: 'The AI is currently resting due to high demand. Please try again later.' });
      }
      // Log full detail server-side only; keep the client-facing message generic.
      const apiErrorMsg = err.response.data?.error?.message || err.response.statusText || 'API Error';
      console.error(`API Error ${err.response.status}:`, apiErrorMsg);
      return res.status(500).json({ error: 'api_error', message: 'AI summary service is temporarily unavailable. Please try again shortly.' });
    }

    console.error('Error generating comment summary:', err.message);
    res.status(500).json({ error: 'Failed to generate summary', message: 'Failed to generate summary. Please try again shortly.' });
  }
});

module.exports = router;
