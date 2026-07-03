#!/usr/bin/env node
/**
 * Garde-fous anti-régression : flux Paddeci → Infinite Core V2 (webhook HMAC).
 * Usage : npm run check:webhook
 *         npm run check:webhook -- --prod   (vérifie config-check en production)
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const checkProd = args.has('--prod');

let failures = 0;

function fail(message) {
  console.error(`✗ ${message}`);
  failures += 1;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

function read(relPath) {
  const full = join(root, relPath);
  if (!existsSync(full)) {
    fail(`Fichier manquant : ${relPath}`);
    return '';
  }
  return readFileSync(full, 'utf8');
}

function assertIncludes(content, needle, label) {
  if (!content.includes(needle)) {
    fail(`${label} : attendu « ${needle} »`);
    return false;
  }
  pass(label);
  return true;
}

function assertExcludes(content, needle, label) {
  if (content.includes(needle)) {
    fail(`${label} : interdit « ${needle} »`);
    return false;
  }
  pass(label);
  return true;
}

console.log('=== Vérification webhook Paddeci → Infinite Core ===\n');

// --- save-audit.js ---
const saveAuditSrc = read('netlify/functions/save-audit.js');
if (saveAuditSrc) {
  assertIncludes(saveAuditSrc, "from './lib/infinite-core-webhook.js'", 'save-audit importe infinite-core-webhook');
  assertExcludes(saveAuditSrc, 'firestore-rest', 'save-audit n’utilise pas firestore-rest');
  assertIncludes(saveAuditSrc, 'postPaddeAuditToInfiniteCore', 'save-audit appelle postPaddeAuditToInfiniteCore');
}

// --- config-check + module webhook ---
assertIncludes(read('netlify/functions/config-check.js'), 'infinite-core-webhook.js', 'config-check utilise infinite-core-webhook');
assertIncludes(read('netlify/functions/lib/infinite-core-webhook.js'), 'X-Webhook-Signature', 'signature HMAC présente');

// --- netlify.toml ---
const toml = read('netlify.toml');
if (toml) {
  assertIncludes(toml, 'INFINITE_CORE_API_URL = "https://www.infinitecore.net"', 'netlify.toml : INFINITE_CORE_API_URL');
  assertIncludes(toml, 'from = "/api/webhooks/padde-ci"', 'netlify.toml : redirect webhook');
  assertIncludes(toml, 'to = "/.netlify/functions/save-audit"', 'netlify.toml : redirect vers save-audit');
  assertExcludes(toml, 'infinitecore.netlify.app', 'netlify.toml sans URL Netlify IC obsolète');
}

// --- Formulaires HTML / JS ---
const formPaths = [
  'PADDE CI/audit-rapide.html',
  'PADDE CI/audit-business.html',
  'PADDE CI/audit-institutionnel.html',
  'PADDE CI/audit-webhook.js',
];

for (const rel of formPaths) {
  const src = read(rel);
  if (!src) continue;
  const label = rel.split('/').pop();
  assertIncludes(src, '/.netlify/functions/save-audit', `${label} : fetch save-audit`);
  if (/fetch\s*\([^)]*infinitecore\.netlify\.app/i.test(src)) {
    fail(`${label} : fetch direct vers infinitecore.netlify.app interdit`);
  } else {
    pass(`${label} : pas de fetch vers infinitecore.netlify.app`);
  }
  if (/fetch\s*\([^)]*www\.infinitecore\.net\/api\/webhooks/i.test(src)) {
    fail(`${label} : fetch direct navigateur vers IC interdit (CORS / checkpoint)`);
  } else {
    pass(`${label} : pas de fetch direct vers API IC`);
  }
}

// --- .env.example ---
const envExample = read('.env.example');
if (envExample) {
  assertIncludes(envExample, 'INFINITE_CORE_API_URL', '.env.example documente INFINITE_CORE_API_URL');
  assertIncludes(envExample, 'PADDE_WEBHOOK_SECRET', '.env.example documente PADDE_WEBHOOK_SECRET');
  assertExcludes(envExample, 'infinitecore.netlify.app', '.env.example sans URL obsolète');
}

// --- Test unitaire HMAC ---
const webhookModuleUrl = pathToFileURL(
  join(root, 'netlify/functions/lib/infinite-core-webhook.js')
).href;
const { signWebhookBody, getWebhookUrl, getInfiniteCoreApiUrl } = await import(webhookModuleUrl);

const sampleBody = '{"type":"audit-rapide","entreprise":"regression-test"}';
const sampleSecret = 'padde-ci-regression-test-secret';
const expectedDigest = createHmac('sha256', sampleSecret).update(sampleBody, 'utf8').digest('hex');
const expectedSig = `sha256=${expectedDigest}`;

if (signWebhookBody(sampleBody, sampleSecret) === expectedSig) {
  pass('signWebhookBody : HMAC-SHA256 conforme');
} else {
  fail('signWebhookBody : signature HMAC incorrecte');
}

const prevApiUrl = process.env.INFINITE_CORE_API_URL;
process.env.INFINITE_CORE_API_URL = 'https://www.infinitecore.net';
if (getInfiniteCoreApiUrl() === 'https://www.infinitecore.net' && getWebhookUrl() === 'https://www.infinitecore.net/api/webhooks/padde-ci') {
  pass('getWebhookUrl : URL IC V2 par défaut');
} else {
  fail(`getWebhookUrl inattendu : ${getWebhookUrl()}`);
}
if (prevApiUrl === undefined) {
  delete process.env.INFINITE_CORE_API_URL;
} else {
  process.env.INFINITE_CORE_API_URL = prevApiUrl;
}

// --- Vérif production optionnelle ---
if (checkProd) {
  console.log('\n=== Vérification production (config-check) ===\n');
  const prodUrl =
    process.env.PADDE_CONFIG_CHECK_URL ||
    'https://paddeci.netlify.app/api/webhooks/padde-ci/config-check';

  try {
    const res = await fetch(prodUrl, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      fail(`config-check prod : réponse non JSON (HTTP ${res.status}) — déployé ? bypass Vercel ?`);
      body = null;
    }

    if (body) {
      if (res.status === 200) {
        pass(`config-check prod : HTTP 200 (${prodUrl})`);
      } else {
        fail(`config-check prod : HTTP ${res.status}`);
      }

      const paddeci = body.paddeci;
      if (paddeci?.infiniteCoreApiUrl?.includes('www.infinitecore.net')) {
        pass('config-check prod : infiniteCoreApiUrl correct');
      } else {
        fail(`config-check prod : infiniteCoreApiUrl invalide (${paddeci?.infiniteCoreApiUrl})`);
      }

      if (paddeci?.webhookSecretConfigured === true) {
        pass('config-check prod : PADDE_WEBHOOK_SECRET configuré sur Netlify');
      } else {
        fail('config-check prod : PADDE_WEBHOOK_SECRET manquant sur Netlify');
      }

      const icStatus = body.infiniteCore?.status;
      const icBody = body.infiniteCore?.body;
      if (icBody?.databaseConfigured === true && icBody?.webhookSecretConfigured === true) {
        pass('config-check prod : Infinite Core database + secret OK');
      } else if (typeof icStatus === 'number' && icStatus !== 200) {
        fail(
          `config-check prod : Infinite Core HTTP ${icStatus} — ajoutez VERCEL_PROTECTION_BYPASS sur Netlify`
        );
      } else {
        fail('config-check prod : Infinite Core config incomplète (checkpoint Vercel ou secret IC)');
      }
    }
  } catch (e) {
    fail(`config-check prod : ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n=== Résultat : ${failures === 0 ? 'OK' : `${failures} échec(s)`} ===`);
process.exit(failures > 0 ? 1 : 0);
