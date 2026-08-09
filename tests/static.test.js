import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createServer } from '../src/server/index.js';

function startServer() {
  const db = openDb(':memory:');
  const server = createServer(db);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, db, port: server.address().port }));
  });
}

function stop({ server, db }) {
  server.close();
  db.close();
}

test('GET / serves the dashboard shell from public/index.html', async () => {
  const ctx = await startServer();
  const res = await fetch(`http://localhost:${ctx.port}/`);
  const body = await res.text();
  stop(ctx);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(body, /AI Must Know/);
  assert.match(body, /app\.js/);
});

test('GET /app.js and /style.css serve real static assets with correct content types', async () => {
  const ctx = await startServer();
  const js = await fetch(`http://localhost:${ctx.port}/app.js`);
  const css = await fetch(`http://localhost:${ctx.port}/style.css`);
  stop(ctx);

  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('static serving does not shadow the existing /api/stories JSON route', async () => {
  const ctx = await startServer();
  const res = await fetch(`http://localhost:${ctx.port}/api/stories`);
  stop(ctx);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.ok(Array.isArray(body.stories));
});

test('static serving cannot escape public/ to read files elsewhere in the repo', async () => {
  const ctx = await startServer();
  const res = await fetch(`http://localhost:${ctx.port}/../../../../package.json`);
  const body = await res.text();
  stop(ctx);

  assert.notEqual(res.status, 200);
  assert.doesNotMatch(body, /"name": "ai-must-know"/);
});
