// ============================================================
// test-static-paths.js – Validates relative paths and imports
// ============================================================
import fs from 'fs';
import path from 'path';

const webDir = path.resolve('web');
const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

const regex = /(?:href|src)=["']([^"']+)["']/g;
let match;
const matches = [];
while ((match = regex.exec(indexHtml)) !== null) {
  matches.push(match[1]);
}

console.log('Checking asset paths in index.html:');
let allOk = true;
for (const p of matches) {
  if (p.startsWith('http://') || p.startsWith('https://')) {
    console.log('  [External CDN OK]', p);
    continue;
  }
  if (p.startsWith('/')) {
    console.error('  [ABSOLUTE PATH ERROR]', p);
    allOk = false;
  } else {
    const fullPath = path.resolve(webDir, p);
    if (fs.existsSync(fullPath)) {
      console.log('  [Relative Exists OK]', p);
    } else {
      console.error('  [MISSING FILE ERROR]', p);
      allOk = false;
    }
  }
}

// Check all JS files import only relative paths
const jsDir = path.join(webDir, 'js');
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));

console.log('\nChecking ES Module imports in web/js:');
const importRegex = /from\s+["']([^"']+)["']/g;
for (const f of jsFiles) {
  const content = fs.readFileSync(path.join(jsDir, f), 'utf8');
  let imp;
  while ((imp = importRegex.exec(content)) !== null) {
    const importPath = imp[1];
    if (importPath.startsWith('/')) {
      console.error(`  [ABSOLUTE IMPORT in ${f}]:`, importPath);
      allOk = false;
    } else if (importPath.startsWith('.')) {
      const resolved = path.resolve(jsDir, importPath);
      if (!fs.existsSync(resolved)) {
        console.error(`  [MISSING IMPORT in ${f}]:`, importPath);
        allOk = false;
      } else {
        console.log(`  [OK ${f}] ->`, importPath);
      }
    }
  }
}

if (!allOk) {
  console.error('\n❌ Static paths verification failed!');
  process.exit(1);
}

console.log('\n✅ ALL STATIC PATHS & IMPORTS ARE 100% RELATIVE AND VALID!\n');
