import { neon } from '@neondatabase/serverless';

export default async function handler() {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (!process.env.NETLIFY_DATABASE_URL) {
    return new Response(
      JSON.stringify({
        error: 'Base de données non configurée',
        detail: 'NETLIFY_DATABASE_URL manquant sur ce site.'
      }),
      { status: 503, headers }
    );
  }

  try {
    const sql = neon(process.env.NETLIFY_DATABASE_URL);

    const audits = await sql`
      SELECT * FROM audits
      ORDER BY date DESC
      LIMIT 100
    `;

    return new Response(JSON.stringify(audits), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers
    });
  }
}
