import { neon } from '@netlify/neon';

export default async function handler() {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const sql = neon();
    
    // Récupérer tous les audits
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