import { spawn, ChildProcess } from 'child_process';
import path from 'path';

const isWindows = process.platform === 'win32';

// Resolve LiteLLM executable path
const litellmPath = isWindows
  ? path.join(process.cwd(), '.venv-litellm', 'Scripts', 'litellm.exe')
  : path.join(process.cwd(), '.venv-litellm', 'bin', 'litellm');

console.log('[dev-entry] Starting LiteLLM proxy...');
const litellmProcess = spawn(litellmPath, ['--config', 'litellm.config.yaml', '--port', '4000'], {
  stdio: 'inherit',
  shell: true,
});

console.log('[dev-entry] Starting Apex CRM dev server...');
const crmProcess = spawn(isWindows ? 'npm.cmd' : 'npm', ['run', 'dev:server'], {
  stdio: 'inherit',
  shell: true,
});

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log('\n[dev-entry] Shutting down services...');

  // Kill LiteLLM
  if (litellmProcess && !litellmProcess.killed) {
    console.log('[dev-entry] Stopping LiteLLM proxy...');
    if (isWindows && litellmProcess.pid) {
      spawn('taskkill', ['/pid', String(litellmProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      litellmProcess.kill('SIGINT');
    }
  }

  // Kill CRM
  if (crmProcess && !crmProcess.killed) {
    console.log('[dev-entry] Stopping Apex CRM...');
    if (isWindows && crmProcess.pid) {
      spawn('taskkill', ['/pid', String(crmProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      crmProcess.kill('SIGINT');
    }
  }
}

// Handle exit signals
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

// Watch child processes
litellmProcess.on('exit', (code) => {
  if (!isCleaningUp) {
    console.log(`[dev-entry] LiteLLM proxy exited with code ${code}`);
    cleanup();
    process.exit(code ?? 0);
  }
});

crmProcess.on('exit', (code) => {
  if (!isCleaningUp) {
    console.log(`[dev-entry] Apex CRM exited with code ${code}`);
    cleanup();
    process.exit(code ?? 0);
  }
});
