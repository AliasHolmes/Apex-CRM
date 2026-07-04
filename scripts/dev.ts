import { spawn, ChildProcess } from 'child_process';
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
process.env.PYTHONUTF8 = process.env.PYTHONUTF8 || '1';
process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING || 'utf-8';

const gatewayMode = (process.env.LLM_GATEWAY_MODE || 'litellm').toLowerCase();
let litellmProcess: ChildProcess | undefined;

if (gatewayMode === 'litellm') {
  const litellmPath = isWindows
    ? path.join(process.cwd(), '.venv-litellm', 'Scripts', 'litellm.exe')
    : path.join(process.cwd(), '.venv-litellm', 'bin', 'litellm');

  console.log('[dev-entry] Starting LiteLLM proxy...');
  litellmProcess = spawn(litellmPath, ['--config', 'litellm.config.yaml', '--port', '4000'], {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
} else {
  console.log(`[dev-entry] Skipping LiteLLM proxy because LLM_GATEWAY_MODE=${gatewayMode}.`);
}

console.log('[dev-entry] Starting Apex CRM dev server...');
const crmProcess = spawn(isWindows ? 'npm.cmd' : 'npm', ['run', 'dev:server'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log('\n[dev-entry] Shutting down Apex CRM...');

  if (litellmProcess && !litellmProcess.killed) {
    console.log('[dev-entry] Stopping LiteLLM proxy...');
    if (isWindows && litellmProcess.pid) {
      spawn('taskkill', ['/pid', String(litellmProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      litellmProcess.kill('SIGINT');
    }
  }

  if (crmProcess && !crmProcess.killed) {
    if (isWindows && crmProcess.pid) {
      spawn('taskkill', ['/pid', String(crmProcess.pid), '/f', '/t'], { stdio: 'ignore' });
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

if (litellmProcess) {
  litellmProcess.on('exit', (code) => {
    if (!isCleaningUp) {
      console.log(`[dev-entry] LiteLLM proxy exited with code ${code}`);
      cleanup();
      process.exit(code ?? 0);
    }
  });
}

crmProcess.on('exit', (code) => {
  if (!isCleaningUp) {
    console.log(`[dev-entry] Apex CRM exited with code ${code}`);
    cleanup();
    process.exit(code ?? 0);
  }
});