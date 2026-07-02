/**
 * Écriture Firestore via REST (sans SDK) — règle padde_audits : create if true.
 * Même base que www.infinitecore.net (firebase-applet-config.json).
 */

const DEFAULT_PROJECT = 'noya-industries-platform';
const DEFAULT_DATABASE = 'ai-studio-42406826-d231-4e61-bda4-7369948f2694';
const DEFAULT_API_KEY = 'AIzaSyBmSQsOxI4IJ7kSDn8z23gl6wZCgfzmGRU';

function firestoreConfig() {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT,
    databaseId: process.env.FIREBASE_DATABASE_ID || DEFAULT_DATABASE,
    apiKey: process.env.FIREBASE_API_KEY || DEFAULT_API_KEY,
  };
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => toFirestoreValue(item)),
      },
    };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [key, nested] of Object.entries(value)) {
      fields[key] = toFirestoreValue(nested);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

function randomId(prefix) {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `${prefix}${hex}`;
}

function auditTypeLabel(type) {
  if (type === 'audit-rapide') return 'Rapide';
  if (type === 'audit-business') return 'Business';
  if (type === 'audit-institutionnel') return 'Institutionnel';
  return 'Institutionnel';
}

function clientNameFromPayload(data) {
  return (
    data.entreprise ||
    data.dirigeant ||
    data.denomination ||
    data.responsable ||
    'Client PADDE-CI'
  );
}

async function createFirestoreDocument(collectionId, documentId, data) {
  const { projectId, databaseId, apiKey } = firestoreConfig();
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${collectionId}`
  );
  url.searchParams.set('documentId', documentId);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Firestore ${collectionId}/${documentId} → ${res.status}`);
    err.code = 'FIRESTORE_HTTP_ERROR';
    err.status = res.status;
    err.detail = text.slice(0, 500);
    throw err;
  }

  return { documentId, collectionId, raw: text };
}

/**
 * Écrit dans padde_audits (+ orders/tasks pour l'admin IC et le pipeline).
 */
export async function writeAuditToInfiniteCoreFirestore(data) {
  const type = data.type || 'audit-generique';
  const label = auditTypeLabel(type);
  const clientName = clientNameFromPayload(data);
  const createdAt = new Date().toISOString();

  const auditId = randomId('PADDE-');
  await createFirestoreDocument('padde_audits', auditId, {
    ...data,
    source: 'padde-ci',
    createdAt,
    processed: false,
  });

  const taskId = randomId('TSK-PADDE-');
  await createFirestoreDocument('tasks', taskId, {
    id: taskId,
    userId: 'system',
    title: `Audit PADDE-CI: ${label}`,
    client: clientName,
    columnId: 'nouveau',
    isOrder: false,
    source: 'padde-ci',
    createdAt,
    updatedAt: createdAt,
    description: `Demande d'audit depuis padde-ci.com\nType: ${type}\nContact: ${data.whatsapp || 'Non fourni'}\n\nDétails:\n${JSON.stringify(data, null, 2)}`,
  });

  const orderId = randomId('CMD-PADDE-');
  await createFirestoreDocument('orders', orderId, {
    id: orderId,
    userId: 'system',
    clientName,
    serviceName: `Audit PADDE-CI: ${label}`,
    status: 'Nouveau',
    source: 'padde-ci',
    createdAt,
    details: data,
  });

  return { auditId, taskId, orderId };
}
