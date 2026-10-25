const jwt = require('jsonwebtoken');
const User = require('../models/User');

function getSessionToken(req) {
  return req.headers.cookie?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('gwic_session='))
    ?.slice('gwic_session='.length);
}

async function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Please log in to continue.' });
  }

  try {
    const { sub, ver } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(sub).select('name email sessionVersion');
    if (!user || user.sessionVersion !== ver) {
      return res.status(401).json({ message: 'Please log in to continue.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Please log in to continue.' });
    }
    return next(error);
  }
}

module.exports = requireAuth;
