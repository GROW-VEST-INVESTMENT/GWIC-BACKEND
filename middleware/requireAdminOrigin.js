const LOCAL_ADMIN_ORIGINS = [
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const PRODUCTION_ADMIN_ORIGINS = ['https://gwic-audit.vercel.app'];

function requireAdminOrigin(req, res, next) {
  const origin = req.get('origin');
  const configuredAdminOrigin = (process.env.ADMIN_URL || '').trim();
  const allowedOrigins = [...PRODUCTION_ADMIN_ORIGINS];
  if (configuredAdminOrigin) allowedOrigins.push(configuredAdminOrigin);
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push(...LOCAL_ADMIN_ORIGINS);
  }

  if (!origin || !allowedOrigins.includes(origin.trim())) {
    return res.status(403).json({ message: 'This admin action must come from an approved admin origin.' });
  }

  return next();
}

module.exports = requireAdminOrigin;
