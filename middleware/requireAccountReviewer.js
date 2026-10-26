const crypto = require('node:crypto');

function requireAccountReviewer(req, res, next) {
  const expectedToken = process.env.ACCOUNT_REVIEW_TOKEN;
  const authorization = req.get('authorization') || '';
  const suppliedToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  if (!expectedToken) {
    return res.status(503).json({ message: 'Account review is not configured.' });
  }
  if (!suppliedToken) {
    return res.status(401).json({ message: 'Account review authorization is required.' });
  }

  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return res.status(401).json({ message: 'Account review authorization is required.' });
  }

  return next();
}

module.exports = requireAccountReviewer;
