// Tailored cover letters: written by the AI from the profile and the job, saved as a one-page PDF
// (data/cover-letters/) for forms that ask for a cover letter file.
const fs = require('fs');
const path = require('path');
const store = require('../store.cjs');
const llm = require('../llm.cjs');
const { getProfile, facts } = require('../profile.cjs');

async function writeCoverLetter(job) {
  const name = facts().name || '';
  return llm.askText(
    `You write cover letters for the candidate in the profile. 170-230 words, plain text, no markdown.
Start with "Dear Hiring Team,". Show you read the job: connect 2-3 concrete results from the profile to its needs.
Mention remote work from the candidate's location only if relevant. End with "Kind regards," and the candidate's full name (${name}).
Never invent facts, employers or numbers that are not in the profile, and keep every achievement with the employer
the profile lists it under. No placeholders.`,
    `PROFILE:\n${getProfile()}\n\nJOB: ${job.title} at ${job.company}\n${(job.description || '').slice(0, 3000)}`,
  );
}

/** A minimal one-page PDF (Helvetica, A4) from plain text. */
function textToPdf(text) {
  const ascii = text
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\x7e\n]/g, '');
  const lines = [];
  for (const para of ascii.split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > 92) { lines.push(line); line = word; }
      else line = (line + ' ' + word).trim();
    }
    lines.push(line);
  }
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 11 Tf 15 TL 60 780 Td\n${lines.slice(0, 48).map((l) => `(${esc(l)}) Tj T*`).join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Writes (or reuses) the cover letter PDF for a job and returns its path. */
async function coverLetterFile(job) {
  const dir = path.join(store.DATA, 'cover-letters');
  fs.mkdirSync(dir, { recursive: true });
  const safe = `${job.company || 'Company'}`.replace(/[^\w-]+/g, '_').slice(0, 40);
  const file = path.join(dir, `Cover_Letter_${safe}_${String(job.id || '').replace(/\W+/g, '_').slice(-12)}.pdf`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, textToPdf(await writeCoverLetter(job)));
  return file;
}

module.exports = { writeCoverLetter, textToPdf, coverLetterFile };
