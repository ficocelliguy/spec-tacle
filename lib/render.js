// spec-tacle renderer: substitute a JSON data blob into the template.
// Pure Node — no external dependencies.
'use strict';
const fs = require('fs');

function render(templatePath, dataPath, outPath) {
  const template = fs.readFileSync(templatePath, 'utf-8');
  const raw = fs.readFileSync(dataPath, 'utf-8');
  const data = JSON.parse(raw);
  // Escape any </script> sequences so the inline <script id="specdata"> block
  // isn't torn apart by the browser HTML parser.
  const payload = JSON.stringify(data).replace(/<\//g, '<\\/');
  if (!template.includes('__SPEC_DATA__')) {
    throw new Error('Template has no __SPEC_DATA__ placeholder');
  }
  const rendered = template.replace('__SPEC_DATA__', payload);
  fs.writeFileSync(outPath, rendered, 'utf-8');
  return outPath;
}

module.exports = { render };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length !== 3) {
    console.error('Usage: node render.js <template.html> <data.json> <output.html>');
    process.exit(1);
  }
  try {
    const out = render(argv[0], argv[1], argv[2]);
    process.stdout.write(`Wrote ${out}\n`);
  } catch (err) {
    console.error(`render error: ${err.message}`);
    process.exit(2);
  }
}
