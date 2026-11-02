const clio = require('../services/connectedWorkspace/clio');
test.each([
  'http://s3.us-west-2.amazonaws.com/file?X-Amz-Signature=synthetic',
  'https://127.0.0.1/file?X-Amz-Signature=synthetic',
  'https://s3.us-west-2.amazonaws.com.evil.test/file?X-Amz-Signature=synthetic',
  'https://s3.eu-west-1.amazonaws.com/file?X-Amz-Signature=synthetic',
  'https://user:pass@s3.us-west-2.amazonaws.com/file?X-Amz-Signature=synthetic',
  'https://s3.us-west-2.amazonaws.com:8443/file?X-Amz-Signature=synthetic',
  'https://s3.us-west-2.amazonaws.com/file',
])('storage host boundary rejects %s', value => expect(() => clio.transferUrl(value)).toThrow());
test.each([
  'https://s3.us-west-2.amazonaws.com/bucket/file?X-Amz-Signature=synthetic',
  'https://bucket.s3.us-east-1.amazonaws.com/file?X-Amz-Signature=synthetic',
])('storage host boundary accepts documented signed US S3 URL %s', value => expect(clio.transferUrl(value)).toBe(value));
test('OAuth callback is restricted to the authoritative same-origin endpoint', () => {
  const base = { APP_BASE_URL: 'https://lpc.example.test', CLIO_CLIENT_ID: 'synthetic', CLIO_CLIENT_SECRET: 'synthetic' };
  expect(clio.configuration(base)?.redirectUri).toBe('https://lpc.example.test/api/integrations/clio/callback');
  expect(clio.configuration({ ...base, CLIO_REDIRECT_URI: 'https://evil.test/api/integrations/clio/callback' })).toBeNull();
  expect(clio.configuration({ ...base, CLIO_REDIRECT_URI: '/api/integrations/clio/callback?next=https://evil.test' })).toBeNull();
  expect(clio.configuration({ ...base, NODE_ENV: 'production', APP_BASE_URL: 'http://lpc.example.test' })).toBeNull();
});
test('selection IDs and operation identities cannot overflow numeric provider IDs or change shapes', () => {
  expect(() => clio.clioId('9007199254740993')).toThrow();
  expect(() => clio.selectedIds(['1','1'])).toThrow();
  expect(() => clio.selectedIds(['1','../2'])).toThrow();
  expect(() => clio.selectedIds(Array.from({ length: 11 }, (_, n) => String(n + 1)))).toThrow();
  expect(() => clio.requestId('short')).toThrow();
  expect(clio.selectedIds(['21','13'])).toEqual(['13','21']);
});
test('declared or streamed oversize documents stop at the configured byte bound', async () => {
  await expect(clio.boundedBody(new Response('a', { headers: { 'content-length': '21' } }), 20)).rejects.toMatchObject({ status: 413 });
  await expect(clio.boundedBody(new Response('123456789'), 8)).rejects.toMatchObject({ status: 413 });
  expect((await clio.boundedBody(new Response('contents'), 8)).toString()).toBe('contents');
});
