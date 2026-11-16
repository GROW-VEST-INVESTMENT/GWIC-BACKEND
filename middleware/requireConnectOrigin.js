function requireConnectOrigin(allowedOrigins) {
  const configuredOrigins = allowedOrigins.filter(Boolean).map((origin) => origin.trim());
  if (process.env.NODE_ENV !== 'production') {
    configuredOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }

  return function checkConnectOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin && configuredOrigins.includes(origin)) return next();
    return res.status(403).json({ message: 'This request origin is not allowed.' });
  };
}

module.exports = requireConnectOrigin;
