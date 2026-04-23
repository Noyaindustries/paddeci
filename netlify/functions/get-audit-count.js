import { neon } from '@netlify/neon';

export default async function handler() {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const sql = neon();
    
    // Récupérer le nombre total d'audits
    const result = await sql`SELECT COUNT(*) as count FROM audits`;
    const count = parseInt(result[0].count);
    
    return new Response(JSON.stringify({ count }), { headers });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, count: 0 }), {
      status: 500,
      headers
    });
  }
}
