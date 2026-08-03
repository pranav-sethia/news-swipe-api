const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const pool = require('../db');
const { authLimiter } = require('../middleware/rateLimiters');
const { sendPasswordResetEmail, sendGoogleAccountNoticeEmail } = require('../email');

const router = express.Router();

router.post('/auth/register', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }
  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    let user;

    // Check if upgrading from guest
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        if (decoded && decoded.user && decoded.user.isGuest) {
          const updateQuery = 'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3 RETURNING id, email';
          const { rows } = await pool.query(updateQuery, [email, passwordHash, decoded.user.id]);
          user = rows[0];
          console.log(`Guest user ${decoded.user.id} upgraded to registered: ${email}`);
        }
      } catch (err) { /* ignore invalid token */ }
    }

    if (!user) {
      const query = 'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email';
      const { rows } = await pool.query(query, [email, passwordHash]);
      user = rows[0];
      console.log(`New user registered: ${email}`);
    }

    const payload = { user: { id: user.id, email: user.email } };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
      (err, token) => {
        if (err) throw err;
        res.status(201).json({ token, user });
      }
    );
  } catch (err) {
    if (err.code === '23505') {
      const { rows } = await pool.query('SELECT auth_provider FROM users WHERE email = $1', [email]);
      if (rows[0]?.auth_provider === 'google') {
        return res.status(400).json({ error: 'This email already has a Google account. Sign in with Google instead.' });
      }
      return res.status(400).json({ error: 'Email already in use.' });
    }
    console.error('Error during registration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const query = 'SELECT * FROM users WHERE email = $1';
    const { rows } = await pool.query(query, [email]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    if (user.auth_provider === 'google') {
      return res.status(401).json({ error: 'This email is linked to Google Sign-In. Continue with Google instead.' });
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const payload = { user: { id: user.id, email: user.email } };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
      (err, token) => {
        if (err) throw err;
        res.json({ token });
      }
    );
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/forgot-password, emails a reset link if the address matches an account.
// Always returns the same generic response so this can't be used to check
// whether a given email has an account here.
router.post('/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const genericResponse = { message: "If an account exists for that email, we've sent a reset link." };

  try {
    const { rows } = await pool.query('SELECT id, email, auth_provider FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (user && user.auth_provider === 'google') {
      // Same generic HTTP response either way, so this can't be used to probe
      // which emails have accounts here or how they signed up. The actual
      // owner finds out what's going on via the email itself.
      await sendGoogleAccountNoticeEmail(user.email);
    } else if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await pool.query(
        'UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3',
        [tokenHash, expires, user.id]
      );

      const frontendUrl = (process.env.FRONTEND_URL || '').split(',')[0].trim() || 'http://localhost:5173';
      const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }
    res.json(genericResponse);
  } catch (err) {
    console.error('Error in forgot-password:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/reset-password, consumes a reset token minted above
router.post('/auth/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires > NOW()',
      [tokenHash]
    );
    const user = rows[0];
    if (!user) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );
    res.json({ message: 'Password updated. You can now sign in.' });
  } catch (err) {
    console.error('Error in reset-password:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/guest, creates an ephemeral, isolated guest account
router.post('/auth/guest', authLimiter, async (req, res) => {
  const guestUuid = crypto.randomUUID();
  const guestEmail = `guest_${guestUuid}@hackerswipe.io`;
  const dummyPassword = crypto.randomBytes(16).toString('hex');

  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(dummyPassword, salt);

    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
      [guestEmail, hash]
    );
    const user = rows[0];
    console.log(`✅ Ephemeral guest account created: ${guestEmail}`);

    const payload = { user: { id: user.id, email: user.email, isGuest: true } };
    // Guest tokens expire in 24 hours
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' }, (err, token) => {
      if (err) throw err;
      res.json({ token });
    });
  } catch (err) {
    console.error('Error creating ephemeral guest session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/google, verifies Google access_token and issues app JWT
router.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential } = req.body; // access_token from redirect flow
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  // If this call carries an active guest session's token, a first-time
  // Google signup can upgrade that same row in place (preserving
  // user_swipes/taste_vector) instead of creating an unrelated new user -
  // mirrors the same guest-upgrade check in /auth/register.
  let guestId = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded && decoded.user && decoded.user.isGuest) {
        guestId = decoded.user.id;
      }
    } catch (err) { /* ignore invalid/expired token */ }
  }

  try {
    // Ping Google to verify token and get user profile
    const { data: googleUser } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${credential}` }
    });

    const email = googleUser.email;
    if (!email) throw new Error('No email found in Google token');

    // Check if user exists
    let { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = rows[0];

    if (!user && guestId) {
      // First-time Google signup starting from a guest session: upgrade the
      // guest's existing row in place instead of inserting a disconnected
      // new user, so their swipes/taste_vector aren't lost. Falls through to
      // the normal insert below if the guest row no longer exists (e.g.
      // already cleaned up).
      const updated = await pool.query(
        "UPDATE users SET email = $1, auth_provider = 'google' WHERE id = $2 RETURNING *",
        [email, guestId]
      );
      user = updated.rows[0];
      if (user) console.log(`✅ Guest user ${guestId} upgraded to Google account: ${email}`);
    }

    // If no user, create one securely with a random unguessable password hash
    if (!user) {
      const dummyPassword = 'GOOGLE_SSO_' + crypto.randomBytes(32).toString('hex');
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(dummyPassword, salt);
      const inserted = await pool.query(
        "INSERT INTO users (email, password_hash, auth_provider) VALUES ($1, $2, 'google') RETURNING *",
        [email, hash]
      );
      user = inserted.rows[0];
      console.log(`✅ Google SSO account created for ${email}`);
    } else if (user.auth_provider !== 'google') {
      // This email already has a real password account. Don't silently
      // convert it to Google - that would make the password stop working
      // with zero warning, and the person may specifically prefer keeping
      // it. Tell them to use it instead, mirroring the reverse case in
      // /auth/login.
      return res.status(401).json({ error: 'This email already has a password account. Sign in with your password instead.' });
    }

    // Issue standard JWT
    const jwtPayload = { user: { id: user.id, email: user.email } };
    jwt.sign(jwtPayload, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
      if (err) throw err;
      res.json({ token, user: { id: user.id, email: user.email } });
    });
  } catch (err) {
    console.error('Google Auth verification failed:', err);
    res.status(401).json({ error: 'Invalid Google Token' });
  }
});

module.exports = router;
