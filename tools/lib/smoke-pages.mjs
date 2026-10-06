/**
 * smoke-pages.mjs — what the smoke runs (tools/smoke.mjs, tools/smoke-cdp.mjs) point
 * the extension at: a plain http page, and an Adminer-looking one for dbtools/boot.js.
 */

import { createServer } from 'node:http';

export const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>smoke</title></head>
<body><h1 id="title">Smoke page</h1><input id="name"><button id="go">Go</button>
<select id="pick"><option>a</option><option>b</option></select></body></html>`;
export const ADMINER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="generator" content="Adminer 4.8.1">
<title>Adminer</title></head><body><div id="menu"></div><div id="content"><p>not a real Adminer page</p></div>
<form><input type="hidden" name="token" value="x"></form></body></html>`;

/** ADMINER_PAGE under /adminer, TEST_PAGE at any other path, on 127.0.0.1:`port` (0 = any free one). */
export function startServer(port) {
  return new Promise((res) => {
    const server = createServer((req, reply) => {
      reply.setHeader('content-type', 'text/html; charset=utf-8');
      reply.end(req.url.startsWith('/adminer') ? ADMINER_PAGE : TEST_PAGE);
    });
    server.listen(port, '127.0.0.1', () => res(server));
  });
}
