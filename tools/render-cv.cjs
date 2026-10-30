// Renders an HTML CV to an A4 PDF with your installed Chrome.
// Usage: node tools/render-cv.cjs path/to/cv.html [out.pdf]   (default output: data/cv/CV.pdf)
const path = require('path');
const { chromium } = require('playwright-core');

const src = process.argv[2];
if (!src) {
  console.log('Usage: node tools/render-cv.cjs path/to/cv.html [out.pdf]');
  process.exit(1);
}
const out = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data', 'cv', 'CV.pdf'));

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const page = await b.newPage();
  await page.goto('file:///' + path.resolve(src).replace(/\\/g, '/'));
  await page.pdf({ path: out, format: 'A4', printBackground: true });
  await b.close();
  console.log('wrote', out);
})();
