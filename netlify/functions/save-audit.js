import { neon } from '@netlify/neon';

/** Relai serveur vers Infinite Core (secret jamais exposé au navigateur). */
async function forwardToInfiniteCore(payload, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const secret = process.env.PADDE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('PADDE_WEBHOOK_SECRET absent : relai Infinite Core ignoré.');
    return { relay: 'skipped_no_secret' };
  }

  const base = (process.env.INFINITE_CORE_API_URL || 'https://www.infinitecore.net').replace(
    /\/$/,
    ''
  );
  const url = `${base}/api/webhooks/padde-ci`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': secret
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  }).finally(() => clearTimeout(t));

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Infinite Core webhook HTTP', res.status, text);
    return { relay: 'failed', status: res.status };
  }

  return { relay: 'ok' };
}

async function persistAudit(data) {
  const sql = neon();

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
    const err = new Error("Type d'audit inconnu");
    err.code = 'BAD_AUDIT_TYPE';
    throw err;
  }
}

export default async function handler(request, context) {
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

    if (!process.env.NETLIFY_DATABASE_URL) {
      return new Response(
        JSON.stringify({
          error: 'Base de données non configurée',
          detail:
            'Ajoutez une base Neon (Netlify : Storage → Neon) pour définir NETLIFY_DATABASE_URL sur ce site.'
        }),
        { status: 503, headers }
      );
    }

    const DB_MS = 9_000;
    try {
      await Promise.race([
        persistAudit(data),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout base de données (${DB_MS} ms)`)), DB_MS)
        )
      ]);
    } catch (dbErr) {
      if (dbErr?.code === 'BAD_AUDIT_TYPE') {
        return new Response(
          JSON.stringify({
            error: "Type d'audit inconnu",
            detail: 'type attendu : audit-rapide | audit-business | audit-institutionnel'
          }),
          { status: 400, headers }
        );
      }
      throw dbErr;
    }

    const useDeferredRelay =
      typeof context?.waitUntil === 'function' && Boolean(process.env.PADDE_WEBHOOK_SECRET);

    const relayPromise = forwardToInfiniteCore(data, {
      timeoutMs: useDeferredRelay ? 12_000 : 5_000
    });

    let infiniteCoreRelay;
    if (useDeferredRelay) {
      try {
        context.waitUntil(
          relayPromise.catch((relayErr) => {
            console.error('Erreur relai Infinite Core (async):', relayErr);
          })
        );
        infiniteCoreRelay = { relay: 'deferred' };
      } catch (waitErr) {
        console.warn('waitUntil a échoué, relai synchrone:', waitErr);
        try {
          infiniteCoreRelay = await relayPromise;
        } catch (relayErr) {
          console.error('Erreur relai Infinite Core:', relayErr);
          infiniteCoreRelay = { relay: 'error', message: relayErr.message };
        }
      }
    } else {
      try {
        infiniteCoreRelay = await relayPromise;
      } catch (relayErr) {
        console.error('Erreur relai Infinite Core:', relayErr);
        infiniteCoreRelay = { relay: 'error', message: relayErr.message };
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Données sauvegardées avec succès',
        infiniteCoreRelay: infiniteCoreRelay.relay,
        ...(infiniteCoreRelay.status && { infiniteCoreHttpStatus: infiniteCoreRelay.status })
      }),
      { headers }
    );
  } catch (error) {
    console.error('Erreur complète:', error);

    return new Response(
      JSON.stringify({
        error: error.message,
        details: error.stack
      }),
      {
        status: 500,
        headers
      }
    );
  }
}
