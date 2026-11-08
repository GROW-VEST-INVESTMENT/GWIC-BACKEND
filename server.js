const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');
const adminRoutes = require('./routes/adminRoutes');
const requireAuth = require('./middleware/requireAuth');
const dashboardRoutes = require('./routes/dashboardRoutes');
const coreLockRoutes = require('./routes/coreLockRoutes');
const coreSavingsRoutes = require('./routes/coreSavingsRoutes');
const walletRoutes = require('./routes/walletRoutes');
const accountRoutes = require('./routes/accountRoutes');
const accountReviewRoutes = require('./routes/accountReviewRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const { startCoreSavingsScheduler } = require('./services/coreSavingsScheduler');
const { handlePaystackWebhook } = require('./controllers/walletController');

const app = express();
const PORT = process.env.PORT || 5000;
const getSessionToken = (req) => req.headers.cookie?.split(';').map((part) => part.trim())
  .find((part) => part.startsWith('gwic_session='))?.slice('gwic_session='.length);
const allowedOrigins = [
  'https://kalmacapital.com',
  'https://www.kalmacapital.com',
  'https://kalmacapital.com.ng',
  'https://www.kalmacapital.com.ng',
  'https://gwic-audit.vercel.app',
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  ...(process.env.CORS_ORIGINS || '').split(','),
  ...(process.env.NODE_ENV !== 'production'
    ? [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:8081',
      'http://127.0.0.1:8081',
      'http://localhost:8082',
      'http://127.0.0.1:8082',
      'http://localhost:8083',
      'http://127.0.0.1:8083',
    ]
    : []),
]
  .filter(Boolean)
  .map((origin) => origin.trim());

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  },
}));
app.post('/api/paystack/webhook', express.raw({ type: 'application/json', limit: '64kb' }), handlePaystackWebhook);
app.use(express.json({ limit: '16kb' }));
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/core-lock', coreLockRoutes);
app.use('/api/core-savings', coreSavingsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/account-review', accountReviewRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.json({
    message: 'Kalma Capital API is running.',
    health: '/api/health',
  });
});

app.get('/api/health', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: 'degraded', database: 'disconnected' });
  }

  try {
    await mongoose.connection.db.admin().ping();
    return res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('MongoDB health check failed:', error.name);
    return res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});

app.post('/api/auth/register', async (req, res, next) => {
  const { name, email, phone = '', goal, product, password } = req.body || {};

  if (
    typeof name !== 'string'
    || typeof email !== 'string'
    || typeof phone !== 'string'
    || typeof goal !== 'string'
    || typeof product !== 'string'
    || typeof password !== 'string'
  ) {
    return res.status(400).json({ message: 'Please complete all required fields.' });
  }

  const normalizedName = name.trim().replace(/\s+/g, ' ');
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPhone = phone.trim();

  if (
    !normalizedName
    || normalizedName.length > 100
    || normalizedEmail.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    || normalizedPhone.length > 32
    || password.length < 8
    || Buffer.byteLength(password, 'utf8') > 72
    || !User.GOALS.includes(goal)
    || !User.PRODUCTS.includes(product)
  ) {
    return res.status(400).json({ message: 'Please check your details and try again.' });
  }
  if (!/^\S+(?:\s+\S+)+$/.test(normalizedName)) {
    return res.status(400).json({ message: 'Enter your full legal name as it appears on your bank account and identity records.' });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Account registration is temporarily unavailable.' });
  }

  try {
    await User.create({
      name: normalizedName,
      email: normalizedEmail,
      phone: normalizedPhone,
      goal,
      product,
      passwordHash: password,
    });
    return res.status(201).json({ message: 'Your account has been created.' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    return next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (
    typeof email !== 'string'
    || typeof password !== 'string'
    || email.trim().length > 254
    || !email.trim()
    || !password
    || Buffer.byteLength(password, 'utf8') > 72
  ) {
    return res.status(400).json({ message: 'Please enter a valid email and password.' });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Login is temporarily unavailable.' });
  }

  try {
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
    const passwordMatches = user
      ? await bcrypt.compare(password, user.passwordHash)
      : false;

    if (!user || !passwordMatches) {
      return res.status(401).json({ message: 'Email or password is incorrect.' });
    }

    const token = jwt.sign(
      { sub: user.id, ver: user.sessionVersion },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    res.cookie('gwic_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 60 * 60 * 1000,
      path: '/',
    });

    return res.json({
      message: 'You are now logged in.',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        status: user.status || 'active',
      },
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role || 'user',
      status: req.user.status || 'active',
    },
  });
});

app.post('/api/auth/logout', async (req, res, next) => {
  const token = getSessionToken(req);
  if (token) {
    try {
      const { sub } = jwt.verify(token, process.env.JWT_SECRET);
      await User.updateOne({ _id: sub }, { $inc: { sessionVersion: 1 } });
    } catch (error) {
      if (error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError') {
        return next(error);
      }
    }
  }

  res.clearCookie('gwic_session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  });
  return res.json({ message: 'You are now logged out.' });
});

app.use((error, req, res, next) => {
  console.error('API request failed:', error.stack || error);
  if (res.headersSent) {
    return next(error);
  }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status
    : 500;
  return res.status(status).json({
    message: error.code === 'PAYSTACK_AUTH'
      ? error.message
      : status < 500 ? error.message : 'Something went wrong. Please try again.',
  });
});

async function startServer() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured.');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters.');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('MongoDB connected.');
  await ensureDefaultAdminUser();
  startCoreSavingsScheduler();
  return app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Backend startup failed:', error.name, error.message);
    process.exitCode = 1;
  });
}

async function ensureDefaultAdminUser() {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  const adminName = (process.env.ADMIN_NAME || 'Kalma Capital Administrator').trim();

  if (!adminEmail && !adminPassword) {
    console.log('Admin bootstrap skipped: admin credentials are not configured.');
    return;
  }
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)
    || Buffer.byteLength(adminPassword, 'utf8') < 12
    || Buffer.byteLength(adminPassword, 'utf8') > 72
  ) {
    throw new Error('Admin bootstrap requires a valid ADMIN_EMAIL and an ADMIN_PASSWORD between 12 and 72 bytes.');
  }

  const existingUser = await User.findOne({ email: adminEmail }).select('+passwordHash');
  if (existingUser) {
    existingUser.name = adminName || existingUser.name;
    existingUser.role = 'super_admin';
    existingUser.status = 'active';
    existingUser.sessionVersion += 1;
    existingUser.passwordHash = adminPassword;
    await existingUser.save();
    console.log('Configured admin account synchronized.');
    return;
  }

  await User.create({
    name: adminName || 'Kalma Capital Administrator',
    email: adminEmail,
    phone: '',
    goal: 'Emergency savings',
    product: 'undecided',
    role: 'super_admin',
    status: 'active',
    passwordHash: adminPassword,
  });
  console.log('Configured admin account created.');
}

module.exports = { app, startServer };
