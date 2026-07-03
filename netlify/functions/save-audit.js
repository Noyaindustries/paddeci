import { neon } from '@neondatabase/serverless';
import { postPaddeAuditToInfiniteCore, getWebhookUrl } from './lib/infinite-core-webhook.js';

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
    'Content-Type': 'application/json',
  };

  if (!request || typeof request.json !== 'function') {
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
      headers,
    });
  }

  try {
    const data = await request.json();
    console.log('Données reçues:', data);

    const ic = await postPaddeAuditToInfiniteCore(data);
    console.log('Audit transmis à Infinite Core:', ic.url, ic.status);

    let database = 'skipped';
    if (process.env.NETLIFY_DATABASE_URL) {
      try {
        const DB_MS = 9_000;
        await Promise.race([
          persistAudit(data),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout base de données (${DB_MS} ms)`)), DB_MS)
          ),
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
        message: 'Audit enregistré dans Infinite Core',
        infiniteCore: ic.body,
        webhookUrl: ic.url,
        database,
      }),
      { headers }
    );
  } catch (error) {
    console.error('Erreur save-audit:', error);

    if (error?.code === 'MISSING_WEBHOOK_SECRET') {
      return new Response(
        JSON.stringify({
          error: 'Configuration manquante',
          detail: error.message,
          hint: 'Définissez PADDE_WEBHOOK_SECRET sur Netlify (identique à Vercel Production).',
        }),
        { status: 503, headers }
      );
    }

    if (error?.code === 'INFINITE_CORE_HTTP_ERROR') {
      const isAuth = error.status === 401 || error.status === 403;
      const isRateLimit = error.status === 429;
      const isWaf = /Vercel Security Checkpoint/i.test(error.detail || '');
      const isDb = error.status === 503;

      return new Response(
        JSON.stringify({
          error: isAuth
            ? 'Webhook non autorisé (secret ou signature HMAC incorrect)'
            : isDb
              ? 'Infinite Core indisponible (base de données)'
              : isRateLimit || isWaf
                ? 'Infinite Core bloque la requête (protection Vercel)'
                : 'Échec de transmission vers Infinite Core',
          detail: error.detail || error.message,
          webhookUrl: error.url || getWebhookUrl(),
          infiniteCoreHttpStatus: error.status,
          hint: isAuth
            ? 'Vérifiez PADDE_WEBHOOK_SECRET identique sur Netlify Paddeci et Vercel Infinite Core.'
            : undefined,
        }),
        { status: 502, headers }
      );
    }

    const isTimeout = error?.name === 'AbortError';
    return new Response(
      JSON.stringify({
        error: isTimeout
          ? 'Infinite Core ne répond pas (délai dépassé)'
          : error.message || 'Erreur lors de la transmission',
        webhookUrl: getWebhookUrl(),
      }),
      { status: isTimeout ? 504 : 500, headers }
    );
  }
}
