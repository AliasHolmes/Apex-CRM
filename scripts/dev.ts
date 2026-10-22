import { spawn, spawnSync, ChildProcess } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const isWindows = process.platform === 'win32';
let omniProcess: ChildProcess | null = null;
let crmProcess: ChildProcess | null = null;
let isCleaningUp = false;

async function isOmniRouteRunning(port = 20128): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureOmniRoute(): Promise<ChildProcess | null> {
  const alreadyRunning = await isOmniRouteRunning();
  if (alreadyRunning) {
    console.log('[dev-entry] OmniRoute gateway is already active on http://localhost:20128');
    return null;
  }

  console.log('[dev-entry] Starting OmniRoute gateway on http://localhost:20128...');
  const omniCommand = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'omniroute';
  const omniArgs = isWindows
    ? ['/d', '/s', '/c', 'omniroute.cmd serve']
    : ['serve'];

  const proc = spawn(omniCommand, omniArgs, {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    windowsHide: true,
    env: process.env,
  });

  const startTime = Date.now();
  const maxWaitMs = 15000;
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isOmniRouteRunning()) {
      console.log('[dev-entry] OmniRoute gateway is ready and listening on http://localhost:20128');
      return proc;
    }
  }

  console.warn('[dev-entry] Warning: OmniRoute did not respond within 15s. Apex CRM will proceed (secondary Byesu provider will serve if OmniRoute is offline).');
  return proc;
}

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

  if (omniProcess && !omniProcess.killed) {
    console.log('[dev-entry] Shutting down spawned OmniRoute gateway...');
    if (isWindows && omniProcess.pid) {
      spawnSync('taskkill', ['/pid', String(omniProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      omniProcess.kill('SIGINT');
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

async function main() {
  omniProcess = await ensureOmniRoute();

  console.log('[dev-entry] Starting Apex CRM dev server...');
  const crmCommand = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const crmArgs = isWindows
    ? ['/d', '/s', '/c', 'npm.cmd run dev:server']
    : ['run', 'dev:server'];

  crmProcess = spawn(crmCommand, crmArgs, {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    windowsHide: true,
    env: process.env,
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
}

void main();
