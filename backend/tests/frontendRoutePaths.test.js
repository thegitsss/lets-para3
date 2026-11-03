const { execFileSync } = require('child_process');
const path = require('path');
const helper = path.resolve(__dirname, '../utils/frontendRoutePaths.js');
function routes(source) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `const {literalRoutePaths}=require(${JSON.stringify(helper)});console.log(JSON.stringify(literalRoutePaths(${JSON.stringify(source)})));`], { encoding: 'utf8', timeout: 10000 }));
}
test('expands only the providers explicitly registered by a finite loop', () => {
  const source = "router.get('/login', handler); for(const provider of ['google','linkedin','microsoft']) { router.get(`/${provider}`, handler); router.get(`/${provider}/callback`, handler); }";
  expect(routes(source)).toEqual(['/login', '/google', '/google/callback', '/linkedin', '/linkedin/callback', '/microsoft', '/microsoft/callback']);
  expect(routes(source)).not.toContain('/unknown/callback');
});
test('does not invent routes for arbitrary runtime loops or comments', () => {
  expect(routes("// router.get('/not-mounted', handler);\nfor(const provider of runtimeProviders) router.get(`/${provider}/callback`, handler);")).toEqual([]);
});
test('does not carry a provider binding through a shadowing function parameter', () => {
  expect(routes("for(const provider of ['google']) { function configure(provider) {router.get(`/${provider}/callback`, handler);} }" )).toEqual([]);
});
test('does not carry a provider binding through a shadowing block declaration', () => {
  expect(routes("for(const provider of ['google']) { {const provider=runtimeValue;router.get(`/${provider}/callback`, handler);} }")).toEqual([]);
});
