import { spawn } from 'child_process';

const isWindows = process.platform === 'win32';

console.log('[dev-entry] Starting Apex CRM dev server...');
const crmProcess = spawn(isWindows ? 'npm.cmd' : 'npm', ['run', 'dev:server'], {
  stdio: 'inherit',
  shell: true,
});

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log('\n[dev-entry] Shutting down Apex CRM...');

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

crmProcess.on('exit', (code) => {
  if (!isCleaningUp) {
    console.log(`[dev-entry] Apex CRM exited with code ${code}`);
    cleanup();
    process.exit(code ?? 0);
  }
});
