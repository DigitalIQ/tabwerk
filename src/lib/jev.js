// Client für Jev, über die OpenRouter Decisions API oder direkt über die TypeSafe API.
// Jev gibt typisierte Antworten zurück: choice, score oder noul.
// Doku: https://docs.typesafe.ai/api.md

import { getSettings, recordUsage, connection, PRICE_PER_INPUT_TOKEN } from './settings.js';
import { t } from './i18n.js';
// Jev liest pro Anfrage höchstens 64k Tokens. Kleine Blöcke halten die Antworten genauer.
export const CHUNK_SIZE = 30;

export class JevError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export async function decide(state, questions) {
  const conn = connection(await getSettings());
  const { key: apiKey, model, endpoint } = conn;
  if (!apiKey) throw new JevError('no-key', t('jev_noKey', conn.name));
  if (!/^(~?typesafe\/)?jev-/.test(model)) throw new JevError('model', t('jev_unknownModel', model));

  let response;
  const started = performance.now();
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Tabwerk',
      },
      body: JSON.stringify({ model, state, questions }),
    });
  } catch (error) {
    throw new JevError('network', t('jev_unreachable', conn.name), String(error));
  }
  const raw = await response.text();
  if (!response.ok) {
    const hint = {
      401: t('jev_invalidKey'),
      402: t('jev_noCredit', conn.name),
      429: t('jev_tooManyRequests'),
    }[response.status] || t('jev_httpError', conn.name, response.status);
    const detail = raw.replaceAll(apiKey, '[REDACTED]').slice(0, 500);
    let reason = '';
    try {
      const body = JSON.parse(detail);
      reason = body.error?.message || body.detail || body.message || '';
      if (typeof reason !== 'string') reason = JSON.stringify(reason).slice(0, 200);
    } catch {}
    throw new JevError('http', reason ? `${hint} ${reason}` : hint, detail);
  }
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new JevError('parse', t('jev_unreadableResponse'));
  }
  const answers = result.answers;
  if (!answers || Object.keys(questions).some((id) => !answers[id])) {
    throw new JevError('answers', t('jev_incompleteAnswers'));
  }
  // OpenRouter meldet Kosten. TypeSafe meldet nur Tokens, dann schätzt Tabwerk.
  let cost = result.usage?.cost;
  const estimated = typeof cost !== 'number' && typeof result.usage?.input_tokens === 'number';
  if (estimated) cost = result.usage.input_tokens * PRICE_PER_INPUT_TOKEN;
  await recordUsage(cost, estimated);
  return { answers, model: result.model, cost, estimated, ms: Math.round(performance.now() - started) };
}

// Teilt viele Fragen auf mehrere Anfragen auf. makeState bekommt die IDs eines Blocks.
export async function decideChunked(ids, makeState, makeQuestion, parallel = 3) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) chunks.push(ids.slice(i, i + CHUNK_SIZE));
  const answers = {};
  let cost = 0;
  let model = '';
  for (let i = 0; i < chunks.length; i += parallel) {
    const batch = chunks.slice(i, i + parallel).map((chunk) => {
      const questions = Object.fromEntries(chunk.map((id) => [id, makeQuestion(id)]));
      return decide(makeState(chunk), questions);
    });
    for (const result of await Promise.all(batch)) {
      Object.assign(answers, result.answers);
      cost += result.cost || 0;
      model = result.model;
    }
  }
  return { answers, cost, model };
}
