/** Diagnostic : aucune dépendance — si 200 ici mais 502 sur save-audit, le souci vient de Neon / du bundle. */
export default async function handler() {
  return new Response(
    JSON.stringify({
      ok: true,
      node: process.version,
      hasDatabaseUrl: Boolean(process.env.NETLIFY_DATABASE_URL)
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
