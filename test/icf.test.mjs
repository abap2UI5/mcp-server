// lib/icf.mjs - the deployed HTTP handlers on the npm backend: the names it
// takes, the route's dispatch, and call_handler's request against a plain
// http server standing in for the backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ICF_MOUNT, icfClassName, icfTarget, isMissingHandler, icfRoute, callHandler } from '../lib/icf.mjs';

test('a handler is named by a plain ABAP class name', () => {
  assert.equal(icfClassName('zcl_lift_driver_http'), 'ZCL_LIFT_DRIVER_HTTP');
  assert.equal(icfClassName(' ZCL_X '), 'ZCL_X');
  for (const bad of ['', null, undefined, '/ABC/CL_X', 'zcl-x', '1ZCL', 'Z'.repeat(31), '../x']) {
    assert.equal(icfClassName(bad), null, String(bad));
  }
});

test('the target splits the class from the rest of the path and keeps the query', () => {
  assert.deepEqual(icfTarget('/zcl_x'), { className: 'ZCL_X', rest: '/' });
  assert.deepEqual(icfTarget('/ZCL_X/a/b?lift=L1&x=%20'), { className: 'ZCL_X', rest: '/a/b?lift=L1&x=%20' });
  assert.deepEqual(icfTarget('/ZCL_X?q=1'), { className: 'ZCL_X', rest: '/?q=1' });
  assert.equal(icfTarget('/'), null);
  assert.equal(icfTarget('/not-a-class/x'), null);
});

test('a missing class is told apart from a handler that failed', () => {
  class CX_SY_CREATE_OBJECT_ERROR extends Error {}
  assert.equal(isMissingHandler(new CX_SY_CREATE_OBJECT_ERROR()), true);
  assert.equal(isMissingHandler(new Error('Class ZCL_X does not implement IF_HTTP_EXTENSION')), true);
  assert.equal(isMissingHandler(new Error('division by zero')), false);
  assert.equal(isMissingHandler(undefined), false);
});

/* A plain http server with the route mounted the way the host mounts it. */
async function withServer(createHandler, fn) {
  const route = icfRoute(createHandler);
  const server = http.createServer((req, res) => {
    // as express matches a mount path: "//__a2ui5/icf" is not it
    if (!req.url.startsWith(`${ICF_MOUNT}/`) && !req.url.startsWith(`${ICF_MOUNT}?`) && req.url !== ICF_MOUNT) { res.statusCode = 418; res.end('framework'); return; }
    req.url = req.url.slice(ICF_MOUNT.length) || '/';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { req.body = Buffer.concat(chunks); route(req, res, (e) => { res.statusCode = 599; res.end(String(e)); }); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('call_handler sends method, path, query and body and returns the answer', async () => {
  const made = [];
  const createHandler = ({ handlerClass }) => {
    made.push(handlerClass);
    return async (req, res) => {
      if (handlerClass === 'ZCL_BROKEN') throw new Error('division by zero');
      if (handlerClass === 'ZCL_GONE') throw Object.assign(new Error('x'), { name: 'CX_SY_CREATE_OBJECT_ERROR' });
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end(JSON.stringify({ c: handlerClass, url: req.url, m: req.method, ct: req.headers['content-type'] ?? null, b: req.body.toString('utf8') }));
    };
  };
  await withServer(createHandler, async (baseUrl) => {
    // with the trailing slash backendBaseUrl() has
    const get = await callHandler({ baseUrl: `${baseUrl}/`, className: 'zcl_endpoint', query: { lift: 'L1', n: 2 } });
    assert.equal(get.status, 200);
    assert.match(get.content_type, /application\/json/);
    assert.deepEqual(JSON.parse(get.body), { c: 'ZCL_ENDPOINT', url: '/?lift=L1&n=2', m: 'GET', ct: null, b: '' });
    assert.equal(get.truncated, false);

    const post = await callHandler({ baseUrl, className: 'ZCL_ENDPOINT', method: 'post', path: 'orders/4 2', query: 'status=IDLE', body: { a: 1 } });
    assert.equal(post.status, 201);
    assert.deepEqual(JSON.parse(post.body), { c: 'ZCL_ENDPOINT', url: '/orders/4%202?status=IDLE', m: 'POST', ct: 'application/json', b: '{"a":1}' });

    const text = await callHandler({ baseUrl, className: 'ZCL_ENDPOINT', method: 'PUT', body: 'x=1', contentType: 'application/x-www-form-urlencoded' });
    assert.equal(JSON.parse(text.body).ct, 'application/x-www-form-urlencoded');

    const cut = await callHandler({ baseUrl, className: 'ZCL_ENDPOINT', query: { pad: 'x'.repeat(100) }, limit: 40 });
    assert.equal(cut.truncated, true);
    assert.equal(cut.body.length, 40);
    assert.ok(cut.bytes > 40);

    const gone = await callHandler({ baseUrl, className: 'ZCL_GONE' });
    assert.equal(gone.status, 404);
    assert.match(gone.body, /no deployed class ZCL_GONE implementing if_http_extension/);
    const broken = await callHandler({ baseUrl, className: 'ZCL_BROKEN' });
    assert.equal(broken.status, 500);
    assert.match(broken.body, /ZCL_BROKEN failed: division by zero/);

    await callHandler({ baseUrl, className: 'ZCL_ENDPOINT' });
    assert.deepEqual(made, ['ZCL_ENDPOINT', 'ZCL_GONE', 'ZCL_BROKEN'], 'one handler per class, made once');
  });
});

test('call_handler refuses what it would have to guess', async () => {
  const baseUrl = 'http://127.0.0.1:9';
  await assert.rejects(callHandler({ baseUrl, className: '/ABC/CL_X' }), /class must be an ABAP class name/);
  await assert.rejects(callHandler({ baseUrl, className: 'ZCL_X', method: 'TRACE' }), /method must be one of/);
  await assert.rejects(callHandler({ baseUrl, className: 'ZCL_X', path: 'a?b=1' }), /put parameters into `query`/);
  await assert.rejects(callHandler({ baseUrl, className: 'ZCL_X', path: '../x' }), /without \? or # or \.\./);
});
