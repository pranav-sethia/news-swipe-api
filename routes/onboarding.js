const express = require('express');
const pool = require('../db');

const router = express.Router();

const ALLOWED_CATEGORIES = [
  'Software Engineering', 'Hardware & Systems', 'Artificial Intelligence',
  'Startups & VC', 'Cybersecurity', 'Business & Finance', 'Science & Space',
  'Design & UI/UX', 'Other',
];

// POST /api/onboarding, save a new user's picked topics, used to bias their
// cold-start feed before they have any swipe history.
router.post('/api/onboarding', async (req, res) => {
  const userId = req.user.id;
  const categories = Array.isArray(req.body.categories)
    ? req.body.categories.filter((c) => ALLOWED_CATEGORIES.includes(c))
    : [];

  try {
    await pool.query('UPDATE users SET onboarding_categories = $1 WHERE id = $2', [categories, userId]);
    res.status(200).json({ categories });
  } catch (err) {
    console.error('Error saving onboarding categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
