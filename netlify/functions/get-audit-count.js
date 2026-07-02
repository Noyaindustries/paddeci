import { neon } from '@neondatabase/serverless';

export default async function handler() {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (!process.env.NETLIFY_DATABASE_URL) {
    return new Response(
      JSON.stringify({
        count: 0,
        configured: false
      }),
      { status: 200, headers }
    );
  }

  try {
    const sql = neon(process.env.NETLIFY_DATABASE_URL);

    const result = await sql`SELECT COUNT(*) as count FROM audits`;
    const count = parseInt(result[0].count, 10);

    return new Response(JSON.stringify({ count }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, count: 0 }), {
      status: 500,
      headers
    });
  }
}
