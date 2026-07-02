/**
 * Écriture Firestore via REST (sans SDK) — règle padde_audits : create if true.
 * Écrit dans la base nommée ET (default) pour couvrir les deux configs admin possibles.
 */

const DEFAULT_PROJECT = 'noya-industries-platform';
const DEFAULT_DATABASE = 'ai-studio-42406826-d231-4e61-bda4-7369948f2694';
const DEFAULT_API_KEY = 'AIzaSyBmSQsOxI4IJ7kSDn8z23gl6wZCgfzmGRU';

function firestoreConfig() {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT,
    apiKey: process.env.FIREBASE_API_KEY || DEFAULT_API_KEY,
  };
}

function targetDatabases() {
  const primary = process.env.FIREBASE_DATABASE_ID || DEFAULT_DATABASE;
  const list = [primary, '(default)'];
  return [...new Set(list)];
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

async function createFirestoreDocument(databaseId, collectionId, documentId, data) {
  const { projectId, apiKey } = firestoreConfig();
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents/${collectionId}`
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
    const err = new Error(`Firestore[${databaseId}] ${collectionId}/${documentId} → ${res.status}`);
    err.code = 'FIRESTORE_HTTP_ERROR';
    err.status = res.status;
    err.detail = text.slice(0, 500);
    err.databaseId = databaseId;
    throw err;
  }

  return { databaseId, documentId, collectionId };
}

async function writeBundleToDatabase(databaseId, data, ids) {
  const type = data.type || 'audit-generique';
  const label = auditTypeLabel(type);
  const clientName = clientNameFromPayload(data);
  const createdAt = new Date().toISOString();

  await createFirestoreDocument(databaseId, 'padde_audits', ids.auditId, {
    ...data,
    source: 'padde-ci',
    createdAt,
    processed: false,
  });

  try {
    await createFirestoreDocument(databaseId, 'tasks', ids.taskId, {
      id: ids.taskId,
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

    await createFirestoreDocument(databaseId, 'orders', ids.orderId, {
      id: ids.orderId,
      userId: 'system',
      clientName,
      serviceName: `Audit PADDE-CI: ${label}`,
      status: 'Nouveau',
      source: 'padde-ci',
      createdAt,
      details: data,
    });
  } catch (secondaryErr) {
    console.warn(`tasks/orders non écrits sur ${databaseId}:`, secondaryErr);
  }

  return databaseId;
}

/**
 * Écrit dans padde_audits (+ orders/tasks) sur toutes les bases cibles.
 */
export async function writeAuditToInfiniteCoreFirestore(data) {
  const ids = {
    auditId: randomId('PADDE-'),
    taskId: randomId('TSK-PADDE-'),
    orderId: randomId('CMD-PADDE-'),
  };

  const results = [];
  let primaryOk = false;

  for (const databaseId of targetDatabases()) {
    try {
      await writeBundleToDatabase(databaseId, data, ids);
      results.push({ databaseId, status: 'ok' });
      if (databaseId === (process.env.FIREBASE_DATABASE_ID || DEFAULT_DATABASE)) {
        primaryOk = true;
      }
    } catch (err) {
      results.push({
        databaseId,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const anyOk = results.some((r) => r.status === 'ok');
  if (!anyOk) {
    const err = new Error('Aucune base Firestore n a accepté l écriture');
    err.code = 'FIRESTORE_HTTP_ERROR';
    err.detail = JSON.stringify(results);
    throw err;
  }

  return { ...ids, databases: results, primaryOk };
}
