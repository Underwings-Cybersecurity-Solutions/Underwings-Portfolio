import http from 'node:http';
import mjml2html from 'mjml';

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 2 * 1024 * 1024; // 2 MB
const SHARED_TOKEN = process.env.SHARED_TOKEN || '';

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'mjml-compiler' });
  }

  if (req.method !== 'POST' || req.url !== '/compile') {
    return send(res, 404, { error: 'Not found' });
  }

  if (SHARED_TOKEN) {
    const auth = req.headers['authorization'] || '';
    const token = String(auth).replace(/^Bearer\s+/i, '').trim();
    if (token !== SHARED_TOKEN) return send(res, 401, { error: 'Unauthorized' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return send(res, 413, { error: err.message });
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return send(res, 400, { error: 'Invalid JSON' });
  }

  const source = String(payload.mjml || '').trim();
  if (!source) return send(res, 400, { error: 'Empty mjml input' });

  try {
    const result = mjml2html(source, {
      validationLevel: 'soft',
      keepComments: false,
      minify: !!payload.minify,
    });
    return send(res, 200, {
      html: result.html,
      errors: (result.errors || []).map((e) => ({
        line: e.line || null,
        message: e.message || '',
        tagName: e.tagName || '',
        formattedMessage: e.formattedMessage || '',
      })),
    });
  } catch (err) {
    return send(res, 422, { error: 'Compilation failed', detail: err && err.message || String(err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mjml-compiler] listening on :${PORT} (token ${SHARED_TOKEN ? 'enabled' : 'disabled'})`);
});
