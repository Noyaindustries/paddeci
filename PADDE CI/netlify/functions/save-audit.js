import { neon } from '@netlify/neon';

/** Relai serveur vers Infinite Core (secret jamais exposé au navigateur). */
async function forwardToInfiniteCore(payload) {
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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': secret
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Infinite Core webhook HTTP', res.status, text);
    return { relay: 'failed', status: res.status };
  }

  return { relay: 'ok' };
}

export default async function handler(request, context) {
  // Gérer les CORS pour permettre les requêtes depuis ton site
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Répondre aux requêtes OPTIONS (pre-flight)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  // Vérifier que c'est une requête POST
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405,
      headers
    });
  }

  try {
    // Récupérer les données envoyées
    const data = await request.json();
    console.log('Données reçues:', data);
    
    // Connexion à la base de données
    const sql = neon(); // utilise automatiquement NETLIFY_DATABASE_URL
    
    // Créer la table si elle n'existe pas
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
    
    // Insérer les données selon le type d'audit
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
    }
    else if (data.type === 'audit-business') {
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
    }
    else if (data.type === 'audit-institutionnel') {
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
      return new Response(
        JSON.stringify({
          error: 'Type d\'audit inconnu',
          detail: 'type attendu : audit-rapide | audit-business | audit-institutionnel'
        }),
        { status: 400, headers }
      );
    }

    let infiniteCoreRelay = { relay: 'skipped_no_secret' };
    try {
      infiniteCoreRelay = await forwardToInfiniteCore(data);
    } catch (relayErr) {
      console.error('Erreur relai Infinite Core:', relayErr);
      infiniteCoreRelay = { relay: 'error', message: relayErr.message };
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
    
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack 
    }), {
      status: 500,
      headers
    });
  }
}