// Public remote job boards: Remotive (API), RemoteOK (API), We Work Remotely (RSS).
const { getJson, getText, decode, stripHtml, classifyTerm } = require('../util.cjs');

// Remotive asks for at most ~4 calls a day, so results are cached per query.
const remotiveCache = new Map();
const REMOTIVE_TTL = 6 * 3600 * 1000;

async function remotive(keyword) {
  const hit = remotiveCache.get(keyword);
  if (hit && Date.now() - hit.at < REMOTIVE_TTL) return hit.jobs;
  const data = await getJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=40`);
  const jobs = (data.jobs || []).map((j) => {
    const description = stripHtml(j.description);
    return {
      id: 'remotive:' + j.id,
      source: 'remotive',
      sourceGroup: 'remote',
      extId: String(j.id),
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      url: j.url,
      applyUrl: j.url,
      pay: j.salary || '',
      postedAt: j.publication_date,
      term: classifyTerm(j.job_type, description),
      description: description.slice(0, 6000),
    };
  });
  remotiveCache.set(keyword, { at: Date.now(), jobs });
  return jobs;
}

/**
 * Whole-word keyword test. Generic words (developer, engineer…) are ignored unless nothing else is left,
 * and every remaining word must appear, so "AI Engineer" needs "ai" and "Full Stack" needs both words.
 */
function matcher(keyword) {
  const all = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const key = all.filter((w) => !/^(developer|engineer|senior|junior|remote)$/.test(w));
  const res = (key.length ? key : all).map((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`));
  return (text) => { const t = text.toLowerCase(); return res.every((r) => r.test(t)); };
}

let remoteOkCache = null;
async function remoteOk(keyword) {
  if (!remoteOkCache || Date.now() - remoteOkCache.at > 3 * 3600 * 1000) {
    const data = await getJson('https://remoteok.com/api');
    remoteOkCache = { at: Date.now(), list: data.filter((j) => j.id) };
  }
  const matches = matcher(keyword);
  return remoteOkCache.list
    .filter((j) => matches(`${j.position} ${(j.tags || []).join(' ')}`))
    .map((j) => {
      const description = stripHtml(j.description);
      const pay = j.salary_min ? `$${Math.round(j.salary_min / 1000)}k–$${Math.round(j.salary_max / 1000)}k / year` : '';
      return {
        id: 'remoteok:' + j.id,
        source: 'remoteok',
        sourceGroup: 'remote',
        extId: String(j.id),
        title: decode(j.position),
        company: decode(j.company),
        location: j.location || 'Remote',
        url: j.url,
        applyUrl: j.apply_url || j.url,
        pay,
        postedAt: j.date,
        term: classifyTerm((j.tags || []).join(' '), description),
        description: description.slice(0, 6000),
      };
    });
}

const WWR_FEEDS = [
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
];
let wwrCache = null;
async function weWorkRemotely(keyword) {
  if (!wwrCache || Date.now() - wwrCache.at > 3 * 3600 * 1000) {
    const items = [];
    for (const feed of WWR_FEEDS) {
      const xml = await getText(feed);
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const tag = (name) => decode((m[1].match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1] || '').trim();
        items.push({
          title: tag('title'), link: tag('link'), region: tag('region'), type: tag('type'),
          skills: tag('skills'), pubDate: tag('pubDate'), description: stripHtml(tag('description')),
        });
      }
    }
    wwrCache = { at: Date.now(), items };
  }
  const matches = matcher(keyword);
  return wwrCache.items
    .filter((i) => matches(`${i.title} ${i.skills}`))
    .map((i) => {
      const [company, ...rest] = i.title.split(': ');
      const slug = i.link.split('/').pop();
      return {
        id: 'wwr:' + slug,
        source: 'wwr',
        sourceGroup: 'remote',
        extId: slug,
        title: rest.join(': ') || i.title,
        company,
        location: i.region || 'Remote',
        url: i.link,
        applyUrl: i.link,
        pay: '',
        postedAt: i.pubDate ? new Date(i.pubDate).toISOString() : '',
        term: classifyTerm(i.type, i.description),
        description: i.description.slice(0, 6000),
      };
    });
}

/** Searches every remote board; one failing board doesn't stop the others. */
async function search({ keywords, log }) {
  const out = [];
  for (const kw of keywords) {
    for (const [name, fn] of [['Remotive', remotive], ['RemoteOK', remoteOk], ['We Work Remotely', weWorkRemotely]]) {
      try { out.push(...await fn(kw)); }
      catch (e) { log?.(`${name} search failed: ${e.message}`, 'warn'); }
    }
  }
  const seen = new Set();
  return out.filter((j) => !seen.has(j.id) && seen.add(j.id));
}

module.exports = { search };
