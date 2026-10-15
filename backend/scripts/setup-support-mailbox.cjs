'use strict';
// Interactive connection setup only. No Render writes, MongoDB access, email
// sends, or message-body reads. Secrets remain in the local ignored file.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const dotenv = require('dotenv');
const TARGET = path.resolve(__dirname, '../.env.support-setup.local');
const SCOPES = 'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ';
class SetupError extends Error {}

function origin(value, subdomain) {
  let url;
  try { url = new URL(value); } catch {}
  const domains = ['zoho.com', 'zoho.eu', 'zoho.in', 'zoho.com.au', 'zoho.jp', 'zohocloud.ca', 'zoho.sa', 'zoho.uk'];
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !domains.some(d => url.hostname === `${subdomain}.${d}`)) {
    throw new SetupError(`Use the official HTTPS ${subdomain} server for your Zoho region, without a path or credentials.`);
  }
  return url.origin;
}
function credential(value) {
  if (!/^[A-Za-z0-9._-]{8,4096}$/.test(String(value || ''))) throw new SetupError('A Zoho credential is missing or contains unexpected characters. Copy only its value.');
  return value;
}
function writePrivate(values, target = TARGET) {
  if (fs.existsSync(target)) {
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new SetupError('The local connection path must be a regular private file.');
  }
  const text = '# Private LPC support connection. Do not commit or paste into chat.\n' + Object.entries(values).map(([k, v]) => {
    if (!/^[A-Z_]+$/.test(k) || /[\r\n\0"\\]/.test(String(v))) throw new SetupError('Connection settings contain an invalid value.');
    return `${k}="${String(v)}"`;
  }).join('\n') + '\n';
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally { try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
async function requestJson(url, options, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new SetupError('Zoho rejected the request. Check the account region, credentials, and read permissions.');
    return await response.json();
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('Zoho could not be reached or returned an unreadable response. No provider error details were printed.');
  }
}
async function tokens(settings, code, fetchImpl = fetch) {
  const body = new URLSearchParams({ client_id: credential(settings.SUPPORT_ZOHO_CLIENT_ID), client_secret: credential(settings.SUPPORT_ZOHO_CLIENT_SECRET),
    ...(code ? { grant_type: 'authorization_code', code: credential(code) } : { grant_type: 'refresh_token', refresh_token: credential(settings.SUPPORT_ZOHO_REFRESH_TOKEN) }) });
  const data = await requestJson(`${origin(settings.SUPPORT_ZOHO_ACCOUNTS_BASE_URL, 'accounts')}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, fetchImpl);
  if (!data.access_token || (code && !data.refresh_token)) throw new SetupError('Zoho did not issue the required token. Generate a fresh code in the same region using the displayed read scopes.');
  credential(data.access_token);
  if (code) credential(data.refresh_token);
  return data;
}
async function discover(settings, accessToken, fetchImpl = fetch) {
  const base = origin(settings.SUPPORT_ZOHO_API_BASE_URL.replace(/\/api\/?$/, ''), 'mail') + '/api';
  const get = async url => {
    const response = await requestJson(url, { headers: { Authorization: `Zoho-oauthtoken ${credential(accessToken)}` } }, fetchImpl);
    if (response.status?.code !== 200 || !Array.isArray(response.data)) throw new SetupError('Zoho did not return the account or folder list. Check the read scopes.');
    return response.data;
  };
  const accounts = await get(base + '/accounts');
  const matches = accounts.filter(a => [a.mailboxAddress, a.primaryEmailAddress, a.incomingUserName, ...(a.emailAddress || []).map(x => x.mailId)].some(x => String(x || '').toLowerCase() === settings.SUPPORT_ZOHO_MAILBOX));
  if (matches.length !== 1) throw new SetupError('This authorization does not identify exactly one account owning help@lets-paraconnect.com. Use the Zoho login that owns that mailbox.');
  const isPrimary = [matches[0].mailboxAddress, matches[0].primaryEmailAddress, matches[0].incomingUserName].some(x => String(x || '').toLowerCase() === settings.SUPPORT_ZOHO_MAILBOX);
  // Aliases share their owner's Inbox. Only the explicitly named support
  // folder is eligible; never fall back to that owner's general Inbox.
  const folderName = isPrimary ? 'Inbox' : 'LPC Support';
  const accountId = matches[0].accountId;
  if (typeof accountId !== 'string' || !/^\d+$/.test(accountId)) throw new SetupError('Zoho returned an account ID without safe string precision.');
  const folders = await get(`${base}/accounts/${accountId}/folders`);
  const intakeFolders = folders.filter(f => String(f.folderName).toLowerCase() === folderName.toLowerCase());
  if (intakeFolders.length !== 1 || typeof intakeFolders[0].folderId !== 'string' || !/^\d+$/.test(intakeFolders[0].folderId)) {
    throw new SetupError(isPrimary ? 'Zoho did not identify a unique Inbox with a precise folder ID.' : 'This support alias requires one dedicated folder named LPC Support and a Zoho incoming filter for the support address. Create that folder and filter, then rerun this command; your saved authorization will be reused.');
  }
  return { accountId, folderId: intakeFolders[0].folderId };
}
function terminalQuestions() {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  output.isTTY = true; output.columns = process.stdout.columns || 100;
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  rl.on('SIGINT', () => { rl.close(); process.stdout.write('\nSetup cancelled.\n'); process.exitCode = 1; });
  return {
    async ask(label, secret = false) {
      const answer = rl.question(label); muted = secret;
      try { return (await answer).trim(); } finally { muted = false; if (secret) process.stdout.write('\n'); }
    },
    close() { rl.close(); output.end(); },
  };
}
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SetupError('Run this command yourself in the VS Code terminal so secret input can stay hidden.');
  console.log('LPC support mailbox setup\nSupport: help@lets-paraconnect.com\nOwner alerts: admin@lets-paraconnect.com\n');
  let settings, code;
  if (fs.existsSync(TARGET)) {
    const info = fs.lstatSync(TARGET);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new SetupError('The existing local connection file must be a regular file readable only by your account.');
    settings = dotenv.parse(fs.readFileSync(TARGET));
    if (settings.SUPPORT_ZOHO_MAILBOX !== 'help@lets-paraconnect.com' || settings.ADMIN_ALERT_EMAIL !== 'admin@lets-paraconnect.com') throw new SetupError('Existing saved addresses differ from the approved LPC addresses. Review them before continuing.');
    console.log('Checking the previously saved private connection.');
  } else {
    const terminal = terminalQuestions();
    try {
      const accounts = origin((await terminal.ask('Zoho Accounts server [https://accounts.zoho.com]: ')) || 'https://accounts.zoho.com', 'accounts');
      const mail = origin((await terminal.ask('Zoho Mail server [https://mail.zoho.com]: ')) || 'https://mail.zoho.com', 'mail');
      console.log('\nIn the Zoho API Console, create/open Self Client and use its Client Secret tab.');
      const clientId = credential(await terminal.ask('Client ID (hidden): ', true));
      const clientSecret = credential(await terminal.ask('Client Secret (hidden): ', true));
      console.log(`\nNow open Generate Code. Use these read scopes:\n${SCOPES}\nDescription: LPC support mailbox. Generate the code now; it expires quickly.\n`);
      code = credential(await terminal.ask('Authorization code (hidden): ', true));
      settings = { ADMIN_ALERT_EMAIL: 'admin@lets-paraconnect.com', SUPPORT_ZOHO_MAILBOX: 'help@lets-paraconnect.com', SUPPORT_ZOHO_CLIENT_ID: clientId, SUPPORT_ZOHO_CLIENT_SECRET: clientSecret, SUPPORT_ZOHO_ACCOUNTS_BASE_URL: accounts, SUPPORT_ZOHO_API_BASE_URL: mail + '/api' };
    } finally { terminal.close(); }
  }
  const result = await tokens(settings, code);
  if (code) {
    settings.SUPPORT_ZOHO_REFRESH_TOKEN = result.refresh_token;
  }
  settings.SUPPORT_SETUP_VERIFIED = 'false';
  writePrivate(settings); // Preserve authorization, but invalidate any previous discovery.
  const { accountId, folderId } = await discover(settings, result.access_token);
  Object.assign(settings, { SUPPORT_ZOHO_ACCOUNT_ID: accountId, SUPPORT_ZOHO_INBOX_FOLDER_ID: folderId, SUPPORT_SETUP_VERIFIED: 'true' });
  writePrivate(settings);
  console.log('\nConnected: support account and intake folder verified.');
  console.log('Saved privately to backend/.env.support-setup.local (Git-ignored, owner-only permissions).');
  console.log('No messages were imported or sent, and Render was not changed. Return to Codex and say: Zoho connected.');
}
if (require.main === module) main().catch(error => { console.error(error instanceof SetupError ? error.message : 'Setup failed. Existing saved credentials were preserved; no secrets were printed.'); process.exitCode = 1; });
module.exports = { SetupError, origin, tokens, discover, writePrivate, requestJson };
