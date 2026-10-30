// Thin OpenAI Chat Completions client (no SDK needed).
const store = require('./store.cjs');

async function complete({ messages, tools, model, json }) {
  const key = store.settings.openaiApiKey;
  if (!key) throw new Error('No OpenAI API key set. Add it in Settings.');
  // store: false keeps prompts and replies out of the OpenAI dashboard "Logs" that the key's organization can browse.
  const body = { model: model || store.settings.chatModel, messages, store: false };
  if (tools?.length) body.tools = tools;
  if (json) body.response_format = { type: 'json_object' };

  // Rate limits (429) and server errors are common on new accounts; retry with backoff.
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      // Timeouts and dropped connections: try again a few times.
      if (attempt >= 3) throw new Error('OpenAI: ' + (e.name === 'TimeoutError' ? 'request timed out' : e.message));
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    const quotaGone = /no credits|insufficient_quota/i.test(data.error?.message || data.error?.code || '');
    if ((res.status === 429 || res.status >= 500) && !quotaGone && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok || data.error) throw new Error('OpenAI: ' + (data.error?.message || res.statusText));
    return data.choices[0].message;
  }
}

/** Ask the fast model for a JSON object. */
async function askJson(system, user) {
  const msg = await complete({
    model: store.settings.fastModel,
    json: true,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return JSON.parse(msg.content || '{}');
}

async function askText(system, user, model) {
  const msg = await complete({
    model: model || store.settings.fastModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return (msg.content || '').trim();
}

module.exports = { complete, askJson, askText };
