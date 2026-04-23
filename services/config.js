import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(rootDir) {
  const file = path.join(rootDir, 'config.json');
  const fallback = {
    versionFallbacks: ['1.19.4', '1.20.4', '1.21.4'],
    defaults: { reconnectDelayMs: 15000, spawnTimeoutMs: 45000, loginTimeoutMs: 15000 },
    afkPresets: {}
  };

  if (!fs.existsSync(file)) {
    return fallback;
  }

  return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}
