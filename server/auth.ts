import fs from 'fs';
import path from 'path';

const AUTH_FILE = path.join(process.cwd(), '.apex_auth.json');

export function loadAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); } catch { }
  }
  // Try Hermes fallback
  const hermesPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.hermes', 'auth', 'google_oauth.json');
  if (fs.existsSync(hermesPath)) {
    try {
      const raw = fs.readFileSync(hermesPath, 'utf-8');
      const hermesAuth = JSON.parse(raw);
      const refreshParts = (hermesAuth.refresh || '').split('|');
      const refresh_token = refreshParts[0];
      const project_id = refreshParts[1] || '';
      const access_token = hermesAuth.access;
      const expires_ms = hermesAuth.expires;
      if (access_token && refresh_token) {
        return {
          access_token,
          refresh_token,
          expires_ms,
          project_id,
          isHermes: true
        };
      }
    } catch { }
  }
  return null;
}

export function saveAuth(data: any) {
  if (data.isHermes) {
    const hermesPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.hermes', 'auth', 'google_oauth.json');
    try {
      let hermesAuth: any = {};
      if (fs.existsSync(hermesPath)) {
        try { hermesAuth = JSON.parse(fs.readFileSync(hermesPath, 'utf-8')); } catch { }
      }
      hermesAuth.access = data.access_token;
      hermesAuth.expires = data.expires_ms;
      const refreshParts = (hermesAuth.refresh || '').split('|');
      refreshParts[0] = data.refresh_token;
      if (data.project_id) refreshParts[1] = data.project_id;
      hermesAuth.refresh = refreshParts.join('|');
      fs.writeFileSync(hermesPath, JSON.stringify(hermesAuth, null, 2));
      return;
    } catch (e) {
      console.error("Failed to write back to hermes auth, falling back to local:", e);
    }
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}
