// Web server entry point (separate from data collection — see scripts/collect.js).
// Serves the API (src/server) from the local database.

import { openDb } from '../src/db/index.js';
import { createServer } from '../src/server/index.js';

const DB_PATH = process.env.DB_PATH || 'data/app.db';
const PORT = Number(process.env.PORT) || 3000;

const db = openDb(DB_PATH);
const server = createServer(db);
server.listen(PORT, () => {
  console.log(`AI Must Know API listening on http://localhost:${PORT} (DB: ${DB_PATH})`);
});
