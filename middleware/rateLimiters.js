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

// llama-3.1-8b-instant was fully removed from Groq's lineup at some point
// (confirmed via /v1/models - not renamed, gone), which silently broke both
// this route and ingest.js's categorization for ~12 days: every call failed
// with "model does not exist," and each caller's per-item try/catch treated
// that as a normal skip, so nothing surfaced as an error. Replaced with
// openai/gpt-oss-20b (+ reasoning_effort: 'low', a real, meaningful cost
// lever for this reasoning-model family - cut a realistic call from ~198 to
// ~1,050-1,550 tokens depending on prompt size vs. what an unconstrained
// reasoning pass would cost). Re-confirmed live against this account's
// actual x-ratelimit-limit-tokens header (this session): 8,000 tokens/min,
// ACCOUNT-WIDE, not per-user or per-IP (see console.groq.com/docs/rate-limits) -
// up from the old model's 6,000. Live-measured against the real
// /api/comments/:hnId/summary route itself (not just an equivalent raw
// prompt): real threads cost 1,300-1,800 total tokens depending on comment
// volume, with reasoning_tokens consistently ~4 (confirms reasoning_effort:
// 'low' is actually suppressing the reasoning overhead this model family
// would otherwise burn); ingest.js's longer categorization prompt costs
// ~1,550. ingest.js shares this same budget in bursts every 2 hours. Capping
// fresh (cache-miss) summary generations at 2/min globally uses at most
// ~3,600 of the 8,000 TPM (both calls at the high end) - still ample
// headroom for ingest.js's periodic burst, kept at the same conservative
// value rather than raised, since it was never the binding constraint. This
// is in-memory and per-process, fine for a single instance; would need a
// shared store (e.g. Redis) if this ever runs on more than one dyno.
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

// General per-user cap for the core app endpoints (feed/swipe/account/onboarding).
// None of these had any rate limiting before - /api/feed in particular runs a
// pgvector ANN query plus a lateral join per call, so an unthrottled scripted
// account could drive real Neon compute cost. Generous enough that no real
// user swiping normally would ever notice it.
const apiActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id), // authMiddleware runs first, so req.user is always set here
  message: { error: 'rate_limited', message: 'Too many requests. Please slow down.' },
});

module.exports = { authLimiter, summaryPerUserLimiter, apiActionLimiter, reserveGroqSummarySlot };
