import {
  fetchInfiniteCoreConfigCheck,
  getInfiniteCoreApiUrl,
  getWebhookUrl,
} from './lib/infinite-core-webhook.js';

export default async function handler() {
  const headers = { 'Content-Type': 'application/json' };
  const secretConfigured = Boolean(process.env.PADDE_WEBHOOK_SECRET?.trim());
  let remote = null;
  try {
    remote = await fetchInfiniteCoreConfigCheck();
  } catch (e) {
    remote = { error: e instanceof Error ? e.message : String(e) };
  }
  return new Response(
    JSON.stringify({
      paddeci: {
        webhookSecretConfigured: secretConfigured,
        infiniteCoreApiUrl: getInfiniteCoreApiUrl(),
        webhookUrl: getWebhookUrl(),
      },
      infiniteCore: remote,
    }),
    { headers }
  );
}
