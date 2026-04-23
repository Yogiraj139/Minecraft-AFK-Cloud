import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

export function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  return req.session.csrfToken;
}

export function requireCsrf(req, res, next) {
  const sent = req.get('x-csrf-token') || req.body?._csrf;
  if (!sent || sent !== req.session.csrfToken) {
    res.status(403).json({ ok: false, error: 'Security token expired. Refresh and try again.' });
    return;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

async function validPassword(password) {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (hash) return bcrypt.compare(password, hash);
  return password && password === (process.env.ADMIN_PASSWORD || 'admin');
}

export function authRoutes({ logger }) {
  const router = express.Router();
  const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });

  router.get('/login', (req, res) => {
    res.render('login', { title: 'Sign In', csrfToken: csrfToken(req), error: '' });
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if ((username === (process.env.ADMIN_USERNAME || 'admin')) && await validPassword(password)) {
      req.session.authenticated = true;
      req.session.username = username;
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      logger.info('auth', `Dashboard login: ${username}`);
      res.redirect('/');
      return;
    }
    logger.warn('auth', `Failed dashboard login: ${username || 'blank'}`);
    res.status(401).render('login', { title: 'Sign In', csrfToken: csrfToken(req), error: 'Invalid username or password' });
  });

  router.post('/logout', requireCsrf, (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  return router;
}
