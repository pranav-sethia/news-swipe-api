const express = require('express');
const pool = require('../db');
const { authLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// GET /api/admin/stats - a real, immediate "how many users do I actually
// have" answer (registered vs. guest, both counted), for checking in on
// growth before/during a marketing push. Not a general admin panel - there's
// no role system in this app, so this is gated by a single shared secret
// (ADMIN_SECRET) rather than a user account. Fails closed: if ADMIN_SECRET
// isn't set, the route always rejects rather than silently having no gate.
//
// registeredUsers/guestUsers are a live snapshot of current `users` rows.
// guest rows are permanently deleted after 7 days inactive
// (scripts/cleanup_guests.js), so guestUsers reflects guests active right
// now, not all guest sessions ever started. lifetimeRegisteredUsers/
// lifetimeGuestUsers come from the append-only `lifetime_signups` counter
// (bumped in routes/auth.js on each account creation) and are never
// decremented by that cleanup job - that's the real "total users ever" number.
router.get('/api/admin/stats', authLimiter, async (req, res) => {
  const expectedSecret = process.env.ADMIN_SECRET;
  if (!expectedSecret || req.headers['x-admin-secret'] !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE email NOT LIKE 'guest_%@hackerswipe.io') AS registered_users,
        COUNT(*) FILTER (WHERE email LIKE 'guest_%@hackerswipe.io') AS guest_users
      FROM users
    `);
    const [{ rows: articleRows }, { rows: swipeRows }, { rows: lifetimeRows }] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM articles'),
      pool.query('SELECT COUNT(*)::int AS count FROM user_swipes'),
      pool.query('SELECT kind, count FROM lifetime_signups'),
    ]);
    const lifetime = Object.fromEntries(lifetimeRows.map((r) => [r.kind, parseInt(r.count, 10)]));

    res.json({
      registeredUsers: parseInt(rows[0].registered_users, 10),
      guestUsers: parseInt(rows[0].guest_users, 10),
      lifetimeRegisteredUsers: lifetime.registered || 0,
      lifetimeGuestUsers: lifetime.guest || 0,
      articlesTotal: articleRows[0].count,
      swipesTotal: swipeRows[0].count,
    });
  } catch (err) {
    console.error('Error fetching admin stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
