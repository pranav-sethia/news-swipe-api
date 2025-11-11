const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * This middleware function checks for a valid JWT in the Authorization header.
 * If valid, it attaches the user's data (like their ID) to the `req` object.
 * If invalid, it blocks the request.
 */
const authMiddleware = (req, res, next) => {
  // 1. Get the token from the 'authorization' header
  const authHeader = req.headers.authorization;

  // 2. Check if it exists and is in the correct 'Bearer <token>' format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  // 3. Extract just the token part
  const token = authHeader.split(' ')[1];

  try {
    // 4. Verify the token using our secret key
    const decodedToken = jwt.verify(token, JWT_SECRET);

    // 5. Token is valid! Attach the user's info to the request object.
    // We will use this in our endpoints (e.g., req.user.id)
    req.user = decodedToken.user;
    
    // 6. Pass control to the next function (our actual endpoint)
    next();
  } catch (err) {
    // 4b. Token is invalid or expired
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

module.exports = authMiddleware;