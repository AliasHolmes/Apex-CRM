const fs = require('fs');

// 1. Fix App.tsx removing old useState definitions
let app = fs.readFileSync('src/App.tsx', 'utf-8');
app = app.replace(/const \[leads, setLeads\] = useState<Lead\[\]>\(\[\]\);\n\s*const \[isHydrated, setIsHydrated\] = useState\(false\);/g, '');
fs.writeFileSync('src/App.tsx', app);

// 2. Fix LeadTable.tsx removing onBulkLeadsAdded and old toast calls
let table = fs.readFileSync('src/components/LeadTable.tsx', 'utf-8');
// remove onBulkLeadsAdded references, change to handleBulkLeadsAdded which is in useLeads
table = table.replace(/onBulkLeadsAdded\(/g, 'handleBulkLeadsAdded(');
// remove toast completely
table = table.replace(/\{toast && \([\s\S]*?\}\)/g, ''); // just remove any stray {toast && ( ... )} blocks
fs.writeFileSync('src/components/LeadTable.tsx', table);

console.log("Fixes phase 2 applied!");
