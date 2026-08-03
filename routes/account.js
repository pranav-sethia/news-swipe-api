const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { apiActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// DELETE /api/account, permanently deletes the current user and their data.
// Self-service, no grace period - but requires re-entering the current
// password for password-based accounts first, since the JWT that
// authenticates this call lives in localStorage and any XSS/token leak
// would otherwise be enough on its own for irreversible account destruction.
// Guests (unguessable random password) and Google-linked accounts (no real
// password at all) skip this check.
router.delete('/api/account', apiActionLimiter, async (req, res) => {
  const userId = req.user.id;
  const { password } = req.body;
  try {
    if (!req.user.isGuest) {
      const { rows } = await pool.query('SELECT auth_provider, password_hash FROM users WHERE id = $1', [userId]);
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'Account not found.' });

      if (user.auth_provider !== 'google') {
        if (!password) {
          return res.status(400).json({ error: 'password_required', message: 'Enter your password to confirm.' });
        }
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: 'Incorrect password.' });
      }
    }

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
