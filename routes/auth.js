const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const pool = require('../db');
const { authLimiter } = require('../middleware/rateLimiters');

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

// POST /auth/guest — creates an ephemeral, isolated guest account
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

// POST /api/auth/google — verifies Google access_token and issues app JWT
router.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential } = req.body; // access_token from redirect flow
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

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

    // If no user, create one securely with a random unguessable password hash
    if (!user) {
      const dummyPassword = 'GOOGLE_SSO_' + crypto.randomBytes(32).toString('hex');
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(dummyPassword, salt);
      const inserted = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
        [email, hash]
      );
      user = inserted.rows[0];
      console.log(`✅ Google SSO account created for ${email}`);
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
