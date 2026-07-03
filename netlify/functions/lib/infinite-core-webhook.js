import { createHmac } from 'node:crypto';

/**
 * Relai vers Infinite Core V2 (Vercel + MongoDB).
 * @see https://www.infinitecore.net/api/webhooks/padde-ci
 *
 * Production exige en général :
 *   X-Webhook-Signature: sha256=<HMAC-SHA256 du corps JSON brut>
 * avec PADDE_WEBHOOK_SECRET identique sur Vercel et Paddeci (Netlify).
 */

export function getInfiniteCoreApiUrl() {
  return (process.env.INFINITE_CORE_API_URL || 'https://www.infinitecore.net').replace(
    /\/$/,
    ''
  );
}

export function getWebhookUrl() {
  const base = getInfiniteCoreApiUrl();
  const path = process.env.INFINITE_CORE_WEBHOOK_PATH || '/api/webhooks/padde-ci';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function signWebhookBody(rawBody, secret) {
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

export function buildWebhookHeaders(rawBody) {
  const secret = process.env.PADDE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    const err = new Error(
      'PADDE_WEBHOOK_SECRET manquant : définissez la même valeur que sur Vercel (Infinite Core).'
    );
    err.code = 'MISSING_WEBHOOK_SECRET';
    throw err;
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'padde-ci-netlify-relay/3.0',
    'X-Webhook-Signature': signWebhookBody(rawBody, secret),
  };

  const vercelBypass =
    process.env.VERCEL_PROTECTION_BYPASS || process.env.INFINITE_CORE_BYPASS_SECRET;
  if (vercelBypass) {
    headers['x-vercel-protection-bypass'] = vercelBypass;
  }

  return headers;
}

/**
 * POST audit vers l'API Infinite Core (obligatoire pour l'admin /admin/audits-padde).
 */
export async function postPaddeAuditToInfiniteCore(payload, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const url = getWebhookUrl();
  const rawBody = JSON.stringify(payload);
  const reqHeaders = buildWebhookHeaders(rawBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: rawBody,
      signal: controller.signal,
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 500) };
    }

    if (!res.ok) {
      const err = new Error(`Infinite Core a répondu ${res.status}`);
      err.code = 'INFINITE_CORE_HTTP_ERROR';
      err.status = res.status;
      err.detail = text.slice(0, 500);
      err.url = url;
      throw err;
    }

    return { url, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Proxy config-check (diagnostic). */
export async function fetchInfiniteCoreConfigCheck() {
  const url = `${getInfiniteCoreApiUrl()}/api/webhooks/padde-ci/config-check`;
  const headers = { Accept: 'application/json' };
  const vercelBypass =
    process.env.VERCEL_PROTECTION_BYPASS || process.env.INFINITE_CORE_BYPASS_SECRET;
  if (vercelBypass) {
    headers['x-vercel-protection-bypass'] = vercelBypass;
  }
  const res = await fetch(url, { headers });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 300) } };
  }
}
