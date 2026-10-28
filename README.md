# HackerSwipe API

The backend for [HackerSwipe](https://hackerswipe.com), a swipe-based Hacker News reader that learns what you like. Swipe right on stories you'd read, left on ones you wouldn't, and the feed adjusts. The frontend lives in [news-swipe-ui](https://github.com/pranav-sethia/news-swipe-ui).

## How it works

**Ingestion.** Every two hours a GitHub Actions job (`.github/workflows/ingest.yml`) pulls the current top Hacker News stories and fetches each article. It extracts the readable text with Mozilla Readability and checks the hero image so near-black placeholder frames don't get shown. Then an LLM on Groq sorts each story into one of nine categories and writes a three-bullet summary. Each story also gets a MiniLM sentence embedding, computed in-process with Transformers.js and stored in Postgres with pgvector. The free Groq budget is split across models and keys, and calls are paced from the rate-limit headers, so the whole pipeline runs at no cost.

**The feed** (`routes/feed.js`) is a small recommender:

1. Retrieve candidates from several pools: stories close to your taste vector (a pgvector nearest-neighbour search), trending stories, and fresh discovery picks.
2. Score them on taste, popularity and freshness. Your taste vector blends a long-memory profile with a short one, so new interests show up fast without wiping out old ones.
3. Re-rank for diversity, so one topic or a set of near-duplicates can't take over the batch.
4. Explain each personal pick with the most similar story you liked ("because you liked …").

Likes, dislikes and skips are learned separately. As you like more stories, the feed shifts from mostly popular picks toward personal ones.

The API also handles accounts (email and Google sign-in, guest accounts, password reset by email), comments, onboarding and basic stats.

## Stack

Node.js and Express, PostgreSQL with pgvector, Transformers.js (all-MiniLM-L6-v2), Groq, Mozilla Readability, Resend for email, Sentry for errors, and GitHub Actions for the ingestion schedule.

## Running it locally

```bash
npm install
node index.js
```

It expects `DATABASE_URL` (Postgres with the pgvector extension), `JWT_SECRET`, `GROQ_API_KEY` (and optionally `GROQ_API_KEY_2`), `GOOGLE_CLIENT_ID`, `FRONTEND_URL`, and for email `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. `SENTRY_DSN` and `ADMIN_SECRET` are optional. Run `node ingest.js` once to fill the database with stories.
