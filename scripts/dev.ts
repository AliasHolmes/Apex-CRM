import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const isWindows = process.platform === 'win32';

function loadEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return values;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

const envFileValues = loadEnvFile();
for (const [key, value] of Object.entries(envFileValues)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
console.log('[dev-entry] Starting Apex CRM dev server...');
// `spawn('npm.cmd', ..., { shell: false })` throws EINVAL on Windows, while
// `shell: true` triggers Node's unescaped-argument warning. Invoke cmd.exe
// directly with a fixed command instead, keeping the Unix path shell-free.
const crmCommand = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const crmArgs = isWindows
  ? ['/d', '/s', '/c', 'npm.cmd run dev:server']
  : ['run', 'dev:server'];
const crmProcess = spawn(crmCommand, crmArgs, {
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: false,
  windowsHide: true,
  env: process.env,
});

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log('\n[dev-entry] Shutting down Apex CRM...');

  if (crmProcess && !crmProcess.killed) {
    if (isWindows && crmProcess.pid) {
      spawnSync('taskkill', ['/pid', String(crmProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      crmProcess.kill('SIGINT');
    }
  }
}

process.on('SIGINT', () => {
  cleanup();
  setTimeout(() => process.exit(0), 500);
});

process.on('SIGTERM', () => {
  cleanup();
  setTimeout(() => process.exit(0), 500);
});

process.on('exit', () => {
  cleanup();
});

crmProcess.on('error', (error) => {
  if (!isCleaningUp) {
    console.error('[dev-entry] Apex CRM dev server failed to start:', error);
    cleanup();
    process.exit(1);
  }
});

crmProcess.on('exit', (code) => {
  if (!isCleaningUp) {
    console.log(`[dev-entry] Apex CRM exited with code ${code}`);
    cleanup();
    process.exit(code ?? 0);
  }
});
