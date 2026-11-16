function requireConnectAdmin(req, res, next) {
  if (!req.user || !['staff', 'admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Kalma Connect management access is required.' });
  }
  return next();
}

module.exports = requireConnectAdmin;
