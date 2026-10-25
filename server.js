const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');
const requireAuth = require('./middleware/requireAuth');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();
const PORT = process.env.PORT || 5000;
const getSessionToken = (req) => req.headers.cookie?.split(';').map((part) => part.trim())
  .find((part) => part.startsWith('gwic_session='))?.slice('gwic_session='.length);
const allowedOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ORIGINS || '').split(','),
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:5173', 'http://127.0.0.1:5173']
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
app.use(express.json({ limit: '16kb' }));
app.use('/api/dashboard', dashboardRoutes);

app.get('/', (req, res) => {
  res.json({
    message: 'GWIC Backend API is running.',
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

  const normalizedName = name.trim();
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
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
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
  return res.status(error.status === 400 ? 400 : 500).json({
    message: error.status === 400 ? 'Invalid request body.' : 'Something went wrong. Please try again.',
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

module.exports = { app, startServer };
