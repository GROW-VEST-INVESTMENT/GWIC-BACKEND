function requireAdmin(req, res, next) {
  if (!['admin', 'super_admin'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'Access denied. Admin privileges are required.' });
  }

  return next();
}

module.exports = requireAdmin;
