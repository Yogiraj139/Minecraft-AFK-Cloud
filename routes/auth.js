import crypto from 'node:crypto';
import express from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function attachCsrfToken(req, res, next) {
  if (!req.session) {
    next();
    return;
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  res.locals.csrfToken = req.session.csrfToken;
  res.locals.currentUser = req.session.userId ? req.session.user : null;
  next();
}

export function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const supplied = req.get('x-csrf-token') || req.body?._csrf;

  if (supplied && req.session?.csrfToken && supplied === req.session.csrfToken) {
    next();
    return;
  }

  res.status(403).json({ ok: false, error: 'Invalid CSRF token' });
}

export function ensureAuthenticated(req, res, next) {
  if (req.session?.userId) {
    next();
    return;
  }

  if (req.path.startsWith('/api')) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return;
  }

  res.redirect('/login');
}

export function authRoutes({ db, loginLimiter }) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.session?.userId) {
      res.redirect('/');
      return;
    }

    res.render('login', {
      title: 'Login',
      error: null
    });
  });

  router.post('/login', loginLimiter, requireCsrf, (req, res) => {
    const user = db.verifyUser(req.body.username, req.body.password);

    if (!user) {
      res.status(401).render('login', {
        title: 'Login',
        error: 'Invalid username or password'
      });
      return;
    }

    req.session.regenerate((error) => {
      if (error) {
        throw error;
      }

      req.session.userId = user.id;
      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role
      };
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.redirect('/');
    });
  });

  router.post('/logout', requireCsrf, (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('cloudafk.sid');
      res.redirect('/login');
    });
  });

  return router;
}
