// Data collection entry point (separate from the web server — see scripts/serve.js).
// Runs source adapters (src/adapters/*) live, falling back per-source to
// fixtures on failure (src/collect), and persists the result to the local
// database (src/db).

import { openDb } from '../src/db/index.js';
import { collectItems, persistItems } from '../src/collect/index.js';
import { translateItems } from '../src/translate/index.js';

const DB_PATH = process.env.DB_PATH || 'data/app.db';

const items = await collectItems();

const db = openDb(DB_PATH);
try {
  const total = persistItems(db, items);
  console.log(`Collected ${items.length} item(s) this run. DB now has ${total} item(s) at ${DB_PATH}.`);
  // Korean text is produced here, not at request time — see src/translate.
  // Only new/changed items cost anything, and no key means English-only.
  await translateItems(db, items);
} finally {
  db.close();
}
