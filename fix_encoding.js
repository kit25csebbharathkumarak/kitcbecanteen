const fs = require('fs');
const path = require('path');

function fixFiles(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') fixFiles(fullPath);
    } else if (fullPath.endsWith('.js') || fullPath.endsWith('.html')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      
      let newContent = content
        .replace(/â‚¹/g, '₹')
        .replace(/×/g, '×')
        .replace(/✅/g, '✅')
        .replace(/-/g, '—')
        .replace(/₹,1/g, '₹');

      if (content !== newContent) {
        fs.writeFileSync(fullPath, newContent, 'utf8');
        console.log('Fixed', fullPath);
      }
    }
  }
}
fixFiles('./frontend');
fixFiles('./backend');
