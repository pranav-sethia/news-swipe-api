const rateLimit = require('express-rate-limit');

// bcrypt (10 salt rounds) measured at ~63ms/hash on this hardware, so a single IP could only
// cost us ~2s of CPU across a full window at this cap. This limit exists to bound junk-account
// creation and credential-stuffing attempts, not CPU load. A real user never needs more than a
// handful of register/login/guest calls per session.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

// Per-user cap on the AI summary feature. This is secondary to the global Groq budget guard
// below, it just stops one account from burning through that shared budget by itself.
const summaryPerUserLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id), // authMiddleware runs first, so req.user is always set here
  message: { error: 'rate_limited', message: 'You’ve hit the hourly summary limit for one account. Please try again later.' },
});

// Groq's llama-3.1-8b-instant free-tier budget is 6,000 tokens/minute, confirmed live against
// this account's actual x-ratelimit-limit-tokens header (2026-08-02), and that budget is
// ACCOUNT-WIDE, not per-user or per-IP (see console.groq.com/docs/rate-limits). Each summary
// call costs ~1,900 tokens (system prompt ~185 + up to 6,000 chars of comments ~1,500 + JSON
// output ~150). ingest.js shares this same budget in bursts every 2 hours. Capping fresh
// (cache-miss) summary generations at 2/min globally uses ~3,800 of the 6,000 TPM, leaving
// headroom for ingestion overlap. This is in-memory and per-process, fine for a single
// instance; would need a shared store (e.g. Redis) if this ever runs on more than one dyno.
const GROQ_SUMMARY_MAX_PER_MIN = 2;
const groqSummaryCallTimestamps = [];
function reserveGroqSummarySlot() {
  const now = Date.now();
  while (groqSummaryCallTimestamps.length && now - groqSummaryCallTimestamps[0] > 60_000) {
    groqSummaryCallTimestamps.shift();
  }
  if (groqSummaryCallTimestamps.length >= GROQ_SUMMARY_MAX_PER_MIN) return false;
  groqSummaryCallTimestamps.push(now);
  return true;
}

module.exports = { authLimiter, summaryPerUserLimiter, reserveGroqSummarySlot };
