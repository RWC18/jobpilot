// Generic application-form filler: reads the visible fields on a page (or inside a dialog),
// answers them from the profile (cached answers first, then the LLM, then simple rules), and fills them in.
const store = require('../store.cjs');
const llm = require('../llm.cjs');
const { getProfile, facts } = require('../profile.cjs');

/** Runs in the page: tags every fillable field with data-jp and describes it. */
function collectInPage(scopeSel) {
  const scope = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!scope) return [];
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (r.width > 0 || r.height > 0) && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelFor = (el) => {
    let t = '';
    if (el.id) t = text(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    if (!t && el.getAttribute('aria-labelledby')) {
      t = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => text(document.getElementById(id))).join(' ');
    }
    if (!t) t = el.getAttribute('aria-label') || '';
    if (!t) t = text(el.closest('label'));
    if (!t) t = text(el.closest('fieldset')?.querySelector('legend'));
    if (!t) {
      for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
        const s = text(p);
        if (s && s.length < 300) { t = s; break; }
      }
    }
    if (!t) t = el.getAttribute('placeholder') || el.name || '';
    return t.slice(0, 300);
  };
  const optionLabel = (el) => text(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || text(el.closest('label')) || el.value;

  let n = 0;
  const tag = (el) => { const id = 'f' + n++; el.setAttribute('data-jp', id); return id; };
  const fields = [];
  const groups = new Map();

  for (const el of scope.querySelectorAll('input, textarea, select')) {
    const type = (el.type || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type) || el.disabled) continue;
    if (type === 'radio') {
      const key = el.name || labelFor(el);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
      continue;
    }
    if (type === 'file') { fields.push({ id: tag(el), kind: 'file', label: labelFor(el) || 'file upload', accept: el.accept || '' }); continue; }
    if (type !== 'checkbox' && (!visible(el) || el.readOnly)) continue;
    const f = {
      id: tag(el),
      kind: el.tagName === 'SELECT' ? 'select' : type === 'checkbox' ? 'checkbox' : el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
      inputType: type,
      label: labelFor(el),
      required: el.required || el.getAttribute('aria-required') === 'true',
      value: type === 'checkbox' ? el.checked : el.value,
      combobox: el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete'),
    };
    if (f.kind === 'select') {
      f.options = [...el.options].map((o) => o.text.trim()).filter((o) => o && !/^(select|choose|--)/i.test(o));
      f.value = el.selectedIndex > 0 ? el.options[el.selectedIndex].text.trim() : '';
    }
    if (f.kind === 'checkbox' && !visible(el) && !el.closest('label, fieldset')) continue;
    fields.push(f);
  }
  for (const [key, els] of groups) {
    const legend = els[0].closest('fieldset')?.querySelector('legend');
    const id = tag(els[0]);
    els.forEach((e) => e.setAttribute('data-jp-group', id));
    const checked = els.find((e) => e.checked);
    fields.push({
      id, kind: 'radio', label: text(legend) || labelFor(els[0].closest('fieldset') || els[0]) || key,
      required: els.some((e) => e.required), options: els.map(optionLabel), value: checked ? optionLabel(checked) : '',
    });
  }
  return fields;
}

const isEmpty = (f) => f.kind === 'checkbox' ? false : !f.value || /^select an option$/i.test(f.value);

const SYSTEM = `You fill in job application forms on behalf of the candidate described in the profile.
Rules:
- Answer truthfully from the profile. Never invent degrees, employers or certifications.
- select / radio: return exactly one of the given options, copied verbatim.
- checkbox: true or false. true for consent needed to process this application (privacy policy, terms, "I confirm the info is accurate"); false for marketing or newsletters.
- "How many years of experience with X": a whole number estimated from the profile (0 if none).
- Numbers only for numeric inputs (inputType number). Salary in the currency/period the label asks for.
- text: short (a few words). textarea: 60-120 words, specific to this job, first person, no fluff.
- Questions about gender, race, veteran or disability status: choose the "prefer not to say / decline" option if present.
Return JSON: {"answers": {"<field id>": <value>, ...}} covering every field you were given.`;

/** Rule-based answers used when the LLM is unavailable. */
function ruleAnswer(f) {
  const p = facts();
  const l = f.label.toLowerCase();
  const pick = (want) => (f.options ? bestOption(f.options, want) : want);
  const place = (p.location || '').replace(/\(.*?\)/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (/first name|given name/.test(l)) return p['first name'];
  if (/last name|surname|family name/.test(l)) return p['last name'];
  if (/full name|^name\b|your name/.test(l)) return p.name;
  if (/e-?mail/.test(l)) return p.email;
  if (/phone|mobile/.test(l)) return (p.phone || '').replace(/\(.*?\)/g, '').replace(/[^\d+]/g, '');
  if (/linkedin/.test(l)) return p.linkedin;
  if (/github/.test(l)) return p.github;
  if (/website|portfolio/.test(l)) return p.website || p.portfolio?.split(/[,\s]+/)[0] || p.github;
  if (/city|location|where .*based/.test(l)) return f.combobox ? place[0] : place.join(', ');
  if (/country/.test(l)) return pick(place[place.length - 1] || '');
  if (/years.*experience|experience.*years/.test(l)) return f.options ? pick('5') : '5';
  if (/notice|start date|available/.test(l)) return '2 weeks';
  if (/hourly|rate/.test(l)) return String(store.settings.prefs.hourlyRate);
  if (/sponsor/.test(l)) return pick('No');
  if (/authori[sz]ed|legally|right to work/.test(l)) return pick('Yes');
  if (/relocat/.test(l)) return pick('Yes');
  if (/remote/.test(l)) return pick('Yes');
  if (/english/.test(l)) return pick('Professional');
  if (/gender|race|ethnic|veteran|disab/.test(l)) return f.options ? pick('prefer not') : 'Prefer not to say';
  if (f.kind === 'checkbox') return /privacy|terms|consent|agree|confirm|accurate/.test(l);
  return null;
}

/** Picks the option that best matches a free-form answer. */
function bestOption(options, want) {
  if (!options?.length) return want;
  const w = String(want).toLowerCase().trim();
  const lower = options.map((o) => o.toLowerCase().trim());
  let i = lower.indexOf(w);
  if (i < 0) i = lower.findIndex((o) => o.startsWith(w) || w.startsWith(o));
  if (i < 0) i = lower.findIndex((o) => o.includes(w) || w.includes(o));
  if (i < 0) {
    const words = w.split(/\W+/).filter(Boolean);
    let best = -1, bestScore = 0;
    lower.forEach((o, k) => {
      const s = words.filter((x) => o.includes(x)).length;
      if (s > bestScore) { best = k; bestScore = s; }
    });
    i = best;
  }
  return options[i < 0 ? 0 : i];
}

async function answerFields(fields, job) {
  const todo = fields.filter((f) => f.kind !== 'file' && (isEmpty(f) || (f.kind === 'checkbox' && f.required && !f.value)));
  const answers = {};
  const unknown = [];
  for (const f of todo) {
    const cached = store.answerFor(f.label);
    if (cached != null && f.kind !== 'textarea' && (!f.options || f.options.includes(cached))) answers[f.id] = cached;
    else unknown.push(f);
  }
  if (!unknown.length) return answers;

  try {
    const out = await llm.askJson(SYSTEM, JSON.stringify({
      profile: getProfile(),
      job: { title: job.title, company: job.company, description: (job.description || '').slice(0, 2000) },
      fields: unknown.map(({ id, kind, inputType, label, options, required }) => ({ id, kind, inputType, label, options, required })),
    }));
    for (const f of unknown) {
      const v = out.answers?.[f.id];
      if (v == null || v === '') continue;
      answers[f.id] = v;
      if (f.kind !== 'textarea') store.rememberAnswer(f.label, f.options ? bestOption(f.options, v) : v);
    }
  } catch (e) {
    store.addLog(`AI unavailable for form answers (${e.message.slice(0, 80)}), using profile rules`, 'warn');
    for (const f of unknown) {
      const v = ruleAnswer(f);
      if (v != null) answers[f.id] = v;
    }
  }
  return answers;
}

async function clickHidden(locator) {
  try { await locator.check({ force: true, timeout: 3000 }); }
  catch { await locator.evaluate((el) => el.click()); }
}

async function fillFields(page, fields, answers, { cvPath, skipFiles }) {
  const files = fields.filter((f) => f.kind === 'file');
  for (const f of fields) {
    const loc = page.locator(`[data-jp="${f.id}"]`).first();
    try {
      if (f.kind === 'file') {
        if (skipFiles || /cover|photo|image|avatar/i.test(f.label)) continue;
        if (files.length === 1 || /resume|cv|curriculum/i.test(f.label)) await loc.setInputFiles(cvPath);
        continue;
      }
      if (!(f.id in answers)) continue;
      const v = answers[f.id];
      if (f.kind === 'select') {
        await loc.selectOption({ label: bestOption(f.options, v) });
      } else if (f.kind === 'radio') {
        const idx = f.options.indexOf(bestOption(f.options, v));
        await clickHidden(page.locator(`[data-jp-group="${f.id}"]`).nth(Math.max(0, idx)));
      } else if (f.kind === 'checkbox') {
        const want = v === true || /^(true|yes|1)$/i.test(String(v));
        if (want !== Boolean(f.value)) await clickHidden(loc);
      } else {
        await loc.fill(String(v));
        if (f.combobox) {
          await page.waitForTimeout(1000);
          await loc.press('ArrowDown');
          await loc.press('Enter');
        }
      }
      await page.waitForTimeout(150 + Math.random() * 350);
    } catch { /* one stubborn field shouldn't stop the rest; validation errors are checked by the caller */ }
  }
}

/** Collects, answers and fills every field inside scopeSel (or the whole page). */
async function fillForm(page, { scopeSel = null, job, cvPath, skipFiles = false }) {
  const fields = await page.evaluate(collectInPage, scopeSel);
  const answers = await answerFields(fields, job);
  await fillFields(page, fields, answers, { cvPath, skipFiles });
  return { fields, answered: Object.keys(answers).length };
}

/** Number of visible validation errors inside scopeSel. */
async function errorCount(page, scopeSel) {
  const pre = scopeSel ? scopeSel + ' ' : '';
  const sel = ['.artdeco-inline-feedback--error', '[role="alert"]', '.field-error', '.error-message', '[aria-invalid="true"]']
    .map((s) => pre + s).join(', ');
  return page.locator(sel).evaluateAll((els) => els.filter((e) => e.offsetParent && (e.innerText || '').trim() || e.getAttribute('aria-invalid') === 'true').length).catch(() => 0);
}

module.exports = { fillForm, errorCount, bestOption };
