const fs = require('fs');
const path = require('path');

function search(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    if (f === 'node_modules') continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      search(p);
    } else if (p.endsWith('.js') || p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.mjs')) {
      const content = fs.readFileSync(p, 'utf8');
      if (/\.\s*fetch\s*=/.test(content) || /\[\s*(['"])fetch\1\s*\]\s*=/.test(content)) {
        console.log("MATCH fetch= in:", p);
      }
    }
  }
}
search(path.join(process.cwd(), 'node_modules', '.vite', 'deps'));
