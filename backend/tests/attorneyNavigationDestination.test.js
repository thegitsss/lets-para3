const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

function check(program) {
  const base = path.resolve(__dirname, "../../frontend/assets/scripts");
  const subject = pathToFileURL(path.join(base, "attorney-v2/navigation-destination.mjs")).href;
  const routes = pathToFileURL(path.join(base, "attorney-v2/routes.mjs")).href;
  const commands = pathToFileURL(path.join(base, "productivity-command-registry.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { resolveAttorneyNavigation as resolve } from ${JSON.stringify(subject)};
    import { parseRoute } from ${JSON.stringify(routes)};
    import ${JSON.stringify(commands)};
    ${program}
  `], { stdio: "pipe" });
}

test("every currently registered Attorney navigation command has a valid current destination", () => check(`
  const context = { role:'attorney', caseId:'aaaaaaaaaaaaaaaaaaaaaaaa', availableMatterTabs:globalThis.LPCProductivityCommands.MATTER_TABS };
  const commands = globalThis.LPCProductivityCommands.listCommands(context);
  assert(commands.some(command => command.code === 'attorney.post_matter'));
  for (const command of commands) {
    const destination = resolve(command.href, 'https://example.test');
    assert.equal(destination?.internal, true, command.code);
    const url = new URL(destination.href, 'https://example.test');
    assert.equal(url.origin, 'https://example.test');
    assert.equal(url.pathname, '/attorney-v2.html');
    assert.equal(parseRoute(url.hash).found, true, command.code);
  }
  assert.deepEqual(resolve('/create-case.html'), { href:'/attorney-v2.html#/matters/new', internal:true });
`));

test("creation handoffs retain exact draft or posting identity and bounded return state", () => check(`
  const draft = 'bbbbbbbbbbbbbbbbbbbbbbbb', posting = 'cccccccccccccccccccccccc';
  for (const key of ['draftId','caseDraftId','caseId']) {
    const query = new URLSearchParams({ [key]:key === 'caseId' ? posting : draft, step:'review', returnTo:'/dashboard-attorney.html?matterSort=deadline#cases:draft' });
    const destination = resolve('/create-case.html?' + query);
    assert.equal(destination.internal, true);
    const route = parseRoute(new URL(destination.href, 'https://lpc.invalid').hash);
    assert.equal(route.name, 'create');
    assert.equal(route.query.get(key), key === 'caseId' ? posting : draft);
    assert.equal(route.query.get('step'), 'review');
    assert.equal(route.query.get('returnTo'), '#/matters?view=draft&matterSort=deadline');
  }
`));

test("navigation rejects ambiguous creation identities and unsafe origin or credential targets", () => check(`
  const id = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  for (const href of [
    '/create-case.html?draftId=bad', '/create-case.html?draftId=' + id + '&caseId=' + id,
    '/create-case.html?draftId=' + id + '&draftId=' + id,
    'https://evil.test/create-case.html', '//evil.test/create-case.html',
    'https://user:password@lpc.invalid/create-case.html', 'javascript:alert(1)',
    '/api/cases', '/create-case.html\\\\other'
  ]) assert.equal(resolve(href), null, href);
  const unsafeReturn = resolve('/create-case.html?returnTo=' + encodeURIComponent('https://evil.test/'));
  assert.equal(parseRoute(new URL(unsafeReturn.href, 'https://lpc.invalid').hash).query.has('returnTo'), false);
`));

test("existing notification object context and permitted public Help actions remain available", () => check(`
  const matter = 'aaaaaaaaaaaaaaaaaaaaaaaa', message = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const destination = resolve('/case-detail.html?caseId=' + matter + '&tab=messages&messageId=' + message);
  assert.equal(destination.href, '/attorney-v2.html#/matters/' + matter + '/messages?messageId=' + message);
  assert.deepEqual(resolve('/attorney-faq.html'), { href:'/attorney-faq.html', internal:false });
  assert.deepEqual(resolve('/contact.html'), { href:'/contact.html', internal:false });
`));
