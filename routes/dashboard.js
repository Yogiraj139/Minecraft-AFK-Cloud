import express from 'express';
import { csrfToken, requireAuth } from './auth.js';

export function dashboardRoutes({ config }) {
  const router = express.Router();
  router.get('/', requireAuth, (req, res) => {
    res.render('dashboard', {
      title: 'CloudAFK Pro X',
      csrfToken: csrfToken(req),
      versionFallbacks: config.versionFallbacks || [],
      afkPresets: Object.keys(config.afkPresets || { passive: {} })
    });
  });
  return router;
}
