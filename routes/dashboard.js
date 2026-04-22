import express from 'express';

export function dashboardRoutes({ db, config }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('dashboard', {
      title: config.appName,
      appName: config.appName,
      profiles: db.listProfiles(),
      proxies: db.listProxies(),
      afkPresets: Object.keys(config.afkPresets),
      versionFallbacks: config.versionFallbacks
    });
  });

  return router;
}
