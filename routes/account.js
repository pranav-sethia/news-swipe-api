const express = require('express');
const pool = require('../db');

const router = express.Router();

// DELETE /api/account, permanently deletes the current user and their data.
// Self-service, single confirmation on the frontend - no grace period.
router.delete('/api/account', async (req, res) => {
  const userId = req.user.id;
  try {
    // Swipes must go first, or the users delete fails on the user_swipes
    // foreign key (same order used by scripts/cleanup_guests.js).
    await pool.query('DELETE FROM user_swipes WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ message: 'Account deleted.' });
  } catch (err) {
    console.error(`Error deleting account for user ${userId}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
