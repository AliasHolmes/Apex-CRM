const fs = require('fs');

let table = fs.readFileSync('src/components/LeadTable.tsx', 'utf-8');

// 1. Add imports
table = table.replace(
  "import React, { useState, useRef } from 'react';",
  "import React, { useState, useRef } from 'react';\nimport { useToast } from '../context/ToastContext';\nimport { useLeads } from '../context/LeadContext';"
);

// 2. Change signature and add hooks
table = table.replace(
  "export default function LeadTable({ leads, onUpdateLeadStage, onUpdateLeadsStage, onDeleteLead, onDeleteLeads, onAddManualLead, onBulkLeadsAdded, onUpdateLeadProfile }: LeadTableProps) {",
  "export default function LeadTable({ onAddManualLead }: { onAddManualLead: () => void }) {\n  const { leads, handleUpdateLeadStage, handleUpdateLeadsStage, handleDeleteLead, handleDeleteLeads, handleUpdateLeadProfile, handleBulkLeadsAdded } = useLeads();\n  const { triggerToast } = useToast();"
);

// 3. Remove local toast states and functions
// Using a regex to flexibly match whitespace (like \r\n vs \n)
table = table.replace(/  const \[toast, setToast\] = useState<string \| null>\(null\);\r?\n/, '');

table = table.replace(/  const triggerToast = \(msg: string\) => \{\r?\n    setToast\(msg\);\r?\n    setTimeout\(\(\) => setToast\(null\), 3000\);\r?\n  \};\r?\n/, '');

// 4. Map prop names to context hook names
table = table.replace(/onUpdateLeadStage/g, 'handleUpdateLeadStage');
table = table.replace(/onUpdateLeadsStage/g, 'handleUpdateLeadsStage');
table = table.replace(/onDeleteLead/g, 'handleDeleteLead');
table = table.replace(/onDeleteLeads/g, 'handleDeleteLeads');
table = table.replace(/onUpdateLeadProfile/g, 'handleUpdateLeadProfile');
table = table.replace(/onBulkLeadsAdded/g, 'handleBulkLeadsAdded');

// 5. Remove JSX toast code block safely
const toastBlockRegex = /\{toast && \([\s\S]*?\}\)\}\s*<\/div>\s*<\/div>\s*<\/div>\s*\)/;
table = table.replace(toastBlockRegex, '</div>\n      </CardContent>\n    </Card>\n  );\n');

// Additional safe-guard for the toast block, if the first regex misses:
table = table.replace(/\{toast && \([\s\S]*?<div className="bg-\[#1e293b\][^>]*>\s*\{toast\}\s*<\/div>\s*<\/div>\s*\)\}/, '');

fs.writeFileSync('src/components/LeadTable.tsx', table);
console.log("LeadTable cleanly updated");
