const axios = require('axios');
const { refreshZohoAccessToken, clearZohoAccessTokenCache } = require('../director/mailImportService');
function configuration() {
  const e=process.env;
  const config={
    mailbox:String(e.SUPPORT_ZOHO_MAILBOX||'help@lets-paraconnect.com').toLowerCase().trim(),
    accountId:e.SUPPORT_ZOHO_ACCOUNT_ID||'', folderId:e.SUPPORT_ZOHO_INBOX_FOLDER_ID||'',
    clientId:e.SUPPORT_ZOHO_CLIENT_ID||'', clientSecret:e.SUPPORT_ZOHO_CLIENT_SECRET||'', refreshToken:e.SUPPORT_ZOHO_REFRESH_TOKEN||'',
    apiBaseUrl:e.SUPPORT_ZOHO_API_BASE_URL||'https://mail.zoho.com/api',
    accountsBaseUrl:e.SUPPORT_ZOHO_ACCOUNTS_BASE_URL||'https://accounts.zoho.com',
  };
  config.configured=Boolean(config.accountId&&config.folderId&&config.clientId&&config.clientSecret&&config.refreshToken);
  config.key=`${config.mailbox}:${config.accountId}:${config.folderId}`;
  return config;
}
function email(value) {
  const raw=String(value||'').trim().toLowerCase();
  const match=raw.match(/<([^<>]+)>/);
  const result=match?match[1]:raw;
  return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result)?result:'';
}
function headers(raw) {
  if(typeof raw==='string') {
    const result={};
    for(const line of raw.replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/)) {
      const at=line.indexOf(':');if(at<1)continue;
      const k=line.slice(0,at).trim().toLowerCase();result[k]=[result[k],line.slice(at+1).trim()].filter(Boolean).join(' ');
    }
    return result;
  }
  return Object.fromEntries(Object.entries(raw||{}).map(([k,v])=>[k.toLowerCase(),Array.isArray(v)?v.join(' '):String(v)]));
}
function plainText(html) {
  return String(html||'').slice(0,1000000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_full,code)=>{
    if(code[0]==='#') {const n=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):Number(code.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[code.toLowerCase()];
  }).replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim();
}
function createZohoMailbox(config=configuration()) {
  async function get(path,params={},retry=true) {
    const token=await refreshZohoAccessToken(config);
    try {
      const response=await axios.get(`${config.apiBaseUrl}${path}`,{params,headers:{Authorization:`Zoho-oauthtoken ${token}`},timeout:20000,maxContentLength:2000000});
      if(response.data?.status?.code!==200 || response.data.data==null)throw new Error('Unexpected support mailbox response.');
      return response.data.data;
    } catch(error) {
      if(retry&&error.response?.status===401){clearZohoAccessTokenCache(config);return get(path,params,false);}
      // Do not let axios errors with OAuth configuration reach logs or clients.
      throw Object.assign(new Error('The support mailbox could not be read. Check its connection and read permissions.'),{statusCode:503});
    }
  }
  const account=`/accounts/${encodeURIComponent(config.accountId)}`;
  return {
    async verify() {
      const accounts=await get('/accounts');
      if(!Array.isArray(accounts))throw new Error('Unexpected mailbox account response.');
      const matches=accounts.filter(a=>[a.mailboxAddress,a.primaryEmailAddress,a.incomingUserName,...(a.emailAddress||[]).map(x=>x.mailId)].some(x=>email(x)===config.mailbox));
      const match=matches[0];
      if(matches.length!==1||typeof match.accountId!=='string'||!/^\d+$/.test(match.accountId)||match.accountId!==config.accountId)throw new Error('The configured Zoho account does not match the support mailbox.');
      const isPrimary=[match.mailboxAddress,match.primaryEmailAddress,match.incomingUserName].some(x=>email(x)===config.mailbox);
      const folderName=isPrimary?'Inbox':'LPC Support';
      const folders=await get(`${account}/folders`);
      const intakeFolders=Array.isArray(folders)?folders.filter(f=>String(f.folderName).toLowerCase()===folderName.toLowerCase()):[];
      // The ID must still identify the expected folder on every sync. An alias
      // must never import the shared mailbox's general Inbox.
      if(intakeFolders.length!==1||typeof intakeFolders[0].folderId!=='string'||!/^\d+$/.test(intakeFolders[0].folderId)||intakeFolders[0].folderId!==config.folderId)throw new Error(`Select the support mailbox ${folderName} folder.`);
    },
    async list(start,limit) {
      const rows=await get(`${account}/messages/view`,{folderId:config.folderId,start,limit,status:'all',sortBy:'date',sortorder:false,includeto:true,includesent:false});
      if(!Array.isArray(rows))throw new Error('Unexpected support mailbox message list.');
      return rows;
    },
    async read(row) {
      if(typeof row.messageId!=='string')throw new Error('Mailbox returned a message ID without string precision.');
      const path=`${account}/folders/${encodeURIComponent(config.folderId)}/messages/${encodeURIComponent(row.messageId)}`;
      const header=await get(`${path}/header`,{raw:false});
      const h=headers(header.headerContent);
      const body=await get(`${path}/content`,{includeBlockContent:false});
      if(typeof body.content!=='string')throw new Error('Unexpected support mailbox message content.');
      const text=plainText(body.content);
      return {headers:h,text:text.slice(0,100000),truncated:text.length>100000,hasAttachments:row.hasAttachment===true||row.hasAttachment==='1'||row.hasAttachment===1};
    },
  };
}
module.exports={configuration,createZohoMailbox,email,headers,plainText};
