const express = require('express');
const axios = require('axios');
const pool = require('../db');
const { summaryPerUserLimiter, reserveGroqSummarySlot } = require('../middleware/rateLimiters');

const router = express.Router();

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

JSON SCHEMA:
{
  "consensus": "A 1-2 sentence overarching sentiment of the thread.",
  "takeaways": ["Point 1", "Point 2", "Point 3"],
  "criticisms": ["Criticism 1"]
}

RULES:
1. If the community is overwhelmingly positive and there are no notable criticisms, return an empty array [] for criticisms.
2. Be extremely concise. Keep takeaways to a single sentence each.`;

    if (!process.env.GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

    if (!reserveGroqSummarySlot()) {
      return res.status(429).json({ error: 'rate_limited', message: 'AI summaries are in high demand right now. Please try again in a minute.' });
    }

    const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: "Comment Thread:\n" + extractedText.substring(0, 6000) }
      ],
      temperature: 0.2,
      response_format: { type: "json_object" }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const responseText = groqRes.data.choices[0].message.content.trim();
    const parsed = JSON.parse(responseText);

    await pool.query(
      `UPDATE articles SET comments_summary = $1, summary_generated_at = NOW() WHERE hn_id = $2`,
      [parsed, hnId]
    );

    res.json({ status: 'success', summary: parsed });
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
