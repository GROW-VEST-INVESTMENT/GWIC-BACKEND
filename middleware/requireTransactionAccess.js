function requireTransactionAccess(req, res, next) {
  if (req.user?.transactionRestricted) {
    return res.status(423).json({
      message: 'Transaction access is temporarily restricted. You can still view your account and contact support.',
    });
  }

  return next();
}

module.exports = requireTransactionAccess;
