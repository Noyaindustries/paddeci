import { neon } from '@neondatabase/serverless';

/** Relai serveur vers Infinite Core (secret jamais exposé au navigateur). */
async function forwardToInfiniteCore(payload, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const secret = process.env.PADDE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error(
      'PADDE_WEBHOOK_SECRET manquant : impossible d envoyer vers Infinite Core.'
    );
    err.code = 'MISSING_WEBHOOK_SECRET';
    throw err;
  }

  const base = (process.env.INFINITE_CORE_API_URL || 'https://www.infinitecore.net').replace(
    /\/$/,
    ''
  );
  const url = `${base}/api/webhooks/padde-ci`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const reqHeaders = {
    'Content-Type': 'application/json',
    'X-Webhook-Secret': secret,
    'User-Agent': 'padde-ci-netlify-webhook/1.0'
  };

  const vercelBypass =
    process.env.VERCEL_PROTECTION_BYPASS || process.env.INFINITE_CORE_BYPASS_SECRET;
  if (vercelBypass) {
    reqHeaders['x-vercel-protection-bypass'] = vercelBypass;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Infinite Core a répondu ${res.status}`);
      err.code = 'INFINITE_CORE_HTTP_ERROR';
      err.status = res.status;
      err.detail = text.slice(0, 500);
      throw err;
    }
  } finally {
    clearTimeout(t);
  }
}

async function persistAudit(data) {
  const sql = neon(process.env.NETLIFY_DATABASE_URL);

  await sql`
    CREATE TABLE IF NOT EXISTS audits (
      id SERIAL PRIMARY KEY,
      type_audit TEXT NOT NULL,
      date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      entreprise TEXT,
      secteur TEXT,
      localisation TEXT,
      responsable TEXT,
      whatsapp TEXT,
      donnees_completes JSONB NOT NULL
    )
  `;

  if (data.type === 'audit-rapide') {
    await sql`
      INSERT INTO audits (
        type_audit,
        entreprise,
        secteur,
        localisation,
        responsable,
        whatsapp,
        donnees_completes
      ) VALUES (
        ${data.type},
        ${data.entreprise},
        ${data.secteur},
        ${data.localisation},
        ${data.responsable},
        ${data.whatsapp},
        ${JSON.stringify(data)}
      )
    `;
  } else if (data.type === 'audit-business') {
    await sql`
      INSERT INTO audits (
        type_audit,
        entreprise,
        responsable,
        whatsapp,
        donnees_completes
      ) VALUES (
        ${data.type},
        ${data.dirigeant},
        ${data.dirigeant},
        ${data.whatsapp},
        ${JSON.stringify(data)}
      )
    `;
  } else if (data.type === 'audit-institutionnel') {
    await sql`
      INSERT INTO audits (
        type_audit,
        entreprise,
        responsable,
        whatsapp,
        donnees_completes
      ) VALUES (
        ${data.type},
        ${data.denomination},
        ${data.representant},
        ${data.whatsapp},
        ${JSON.stringify(data)}
      )
    `;
  } else {
    await sql`
      INSERT INTO audits (
        type_audit,
        entreprise,
        responsable,
        whatsapp,
        donnees_completes
      ) VALUES (
        ${data.type || 'audit-generique'},
        ${data.entreprise ?? data.denomination ?? null},
        ${data.responsable ?? data.dirigeant ?? data.representant ?? null},
        ${data.whatsapp ?? null},
        ${JSON.stringify(data)}
      )
    `;
  }
}

export default async function handler(request) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (!request || typeof request.json !== 'function') {
    console.error('save-audit: requête non standard (attendu Request Web API)');
    return new Response(
      JSON.stringify({ error: 'Format de requête incompatible avec ce runtime' }),
      { status: 500, headers }
    );
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405,
      headers
    });
  }

  try {
    const data = await request.json();
    console.log('Données reçues:', data);

    await forwardToInfiniteCore(data);
    console.log('Audit transmis à Infinite Core');

    let database = 'skipped';
    if (process.env.NETLIFY_DATABASE_URL) {
      try {
        const DB_MS = 9_000;
        await Promise.race([
          persistAudit(data),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout base de données (${DB_MS} ms)`)), DB_MS)
          )
        ]);
        database = 'ok';
      } catch (dbErr) {
        console.error('Sauvegarde Neon échouée (audit déjà chez Infinite Core):', dbErr);
        database = 'error';
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Audit transmis à Infinite Core',
        infiniteCoreRelay: 'ok',
        database
      }),
      { headers }
    );
  } catch (error) {
    console.error('Erreur save-audit:', error);

    if (error?.code === 'MISSING_WEBHOOK_SECRET') {
      return new Response(
        JSON.stringify({
          error: 'Configuration manquante',
          detail:
            'Définissez PADDE_WEBHOOK_SECRET (Netlify ou fichier .env local) pour relayer les audits vers Infinite Core.'
        }),
        { status: 503, headers }
      );
    }

    if (error?.code === 'INFINITE_CORE_HTTP_ERROR') {
      const isAuth = error.status === 401 || error.status === 403;
      const isRateLimit = error.status === 429;
      const isWaf = /Vercel Security Checkpoint/i.test(error.detail || '');

      return new Response(
        JSON.stringify({
          error: isAuth
            ? 'Secret webhook invalide pour Infinite Core'
            : isRateLimit || isWaf
              ? 'Infinite Core bloque la requête (protection Vercel / limite)'
              : 'Échec de transmission vers Infinite Core',
          detail: isAuth
            ? 'Vérifiez que PADDE_WEBHOOK_SECRET est identique sur Netlify et Infinite Core.'
            : isWaf
              ? 'Ajoutez VERCEL_PROTECTION_BYPASS dans .env si le site Infinite Core est protégé.'
              : error.detail || error.message,
          infiniteCoreHttpStatus: error.status
        }),
        { status: 502, headers }
      );
    }

    const isTimeout = error?.name === 'AbortError';
    return new Response(
      JSON.stringify({
        error: isTimeout
          ? 'Infinite Core ne répond pas (délai dépassé)'
          : error.message || 'Erreur lors de la transmission'
      }),
      { status: isTimeout ? 504 : 500, headers }
    );
  }
}
