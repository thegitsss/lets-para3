// Local homepage preview with the public map feed from the running development app.
// Bind only to loopback; forward only this public, read-only aggregate endpoint.
const express = require('express');
const http = require('http');
const path = require('path');
const app = express();
app.get('/api/public/paralegals/state-counts', (_req, res) => {
  const upstream = http.get('http://127.0.0.1:5050/api/public/paralegals/state-counts', { timeout: 15000 }, response => {
    res.status(response.statusCode);
    res.set('Content-Type', response.headers['content-type'] || 'application/json');
    res.set('Cache-Control', 'no-store');
    response.pipe(res);
    response.on('error', () => res.destroy());
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Map request timed out')));
  upstream.on('error', () => {
    if (!res.headersSent) res.status(503).json({ error: 'The local backend must be running on port 5050.' });
    else res.destroy();
  });
});
app.use(express.static(path.resolve(__dirname, '../../frontend')));
app.listen(5056, '127.0.0.1', () => console.log('Homepage preview: http://127.0.0.1:5056'));
