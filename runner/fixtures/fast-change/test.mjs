import fs from 'node:fs';

const css = fs.readFileSync(new URL('./styles/app.css', import.meta.url), 'utf8');
const block = css.match(/\.button\s*\{([^}]*)\}/);

if (!block) {
  console.error('styles/app.css has no .button rule');
  process.exit(1);
}

const declarations = block[1]
  .split(';')
  .map((declaration) => declaration.trim())
  .filter(Boolean);
const padding = declarations
  .map((declaration) => declaration.match(/^padding\s*:\s*(.+)$/))
  .find(Boolean);

if (!padding) {
  console.error('the .button rule has no padding declaration');
  process.exit(1);
}

if (padding[1].trim() !== '0.75rem') {
  console.error(`expected .button padding 0.75rem, found ${padding[1].trim()}`);
  process.exit(1);
}

console.log('.button padding is 0.75rem');
