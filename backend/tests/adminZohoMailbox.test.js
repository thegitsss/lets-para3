jest.mock('axios',()=>({get:jest.fn()}));
jest.mock('../services/director/mailImportService',()=>({refreshZohoAccessToken:jest.fn(async()=>'synthetic-token'),clearZohoAccessTokenCache:jest.fn()}));
const axios=require('axios');
const {createZohoMailbox}=require('../services/support/zohoMailbox');
const {clearZohoAccessTokenCache}=require('../services/director/mailImportService');
const config={mailbox:'help@example.test',accountId:'123',folderId:'456',apiBaseUrl:'https://mail.zoho.com/api'};
const ok=data=>({data:{status:{code:200},data}});
beforeEach(()=>jest.clearAllMocks());
test('verifies the exact configured mailbox and Inbox rather than selecting the first account',async()=>{
  axios.get.mockResolvedValueOnce(ok([{accountId:'999',primaryEmailAddress:'different@example.test'},{accountId:'123',primaryEmailAddress:'help@example.test'}])).mockResolvedValueOnce(ok([{folderId:'456',folderName:'Inbox'}]));
  await createZohoMailbox(config).verify();
  expect(axios.get.mock.calls[1][0]).toBe('https://mail.zoho.com/api/accounts/123/folders');
  axios.get.mockResolvedValueOnce(ok([{accountId:'123',primaryEmailAddress:'different@example.test'}]));
  await expect(createZohoMailbox(config).verify()).rejects.toThrow('does not match');
  expect(axios.get).toHaveBeenCalledTimes(3);
});
test('rejects a non-Inbox folder and malformed provider success responses',async()=>{
  axios.get.mockResolvedValueOnce(ok([{accountId:'123',primaryEmailAddress:'help@example.test'}])).mockResolvedValueOnce(ok([{folderId:'456',folderName:'Sent'}]));
  await expect(createZohoMailbox(config).verify()).rejects.toThrow('Inbox');
  axios.get.mockResolvedValueOnce({data:{status:{code:500}}});
  await expect(createZohoMailbox(config).list(201,20)).rejects.toMatchObject({statusCode:503});
});
test('uses documented pagination and reads headers and plain text without modifying the mailbox',async()=>{
  axios.get.mockResolvedValueOnce(ok([]));
  const mailbox=createZohoMailbox(config);await mailbox.list(201,20);
  expect(axios.get.mock.calls[0][1].params).toMatchObject({start:201,limit:20,folderId:'456',sortorder:false,includesent:false});
  axios.get.mockResolvedValueOnce(ok({headerContent:{From:['visitor@example.test'],'In-Reply-To':['<exact@test>']}})).mockResolvedValueOnce(ok({content:'<p>Hello &amp; thanks</p>'}));
  const result=await mailbox.read({messageId:'9000000000000000001',hasAttachment:'1'});
  expect(result.text).toBe('Hello & thanks');expect(result.headers['in-reply-to']).toBe('<exact@test>');expect(result.hasAttachments).toBe(true);
  expect(axios.get.mock.calls[1][0]).toContain('/9000000000000000001/header');
  expect(axios.get.mock.calls[2][1].params).toEqual({includeBlockContent:false});
  await expect(mailbox.read({messageId:9000000000000000001})).rejects.toThrow('string precision');
});
test('refreshes an expired token once and does not expose provider errors containing secrets',async()=>{
  axios.get.mockRejectedValueOnce({response:{status:401},config:{secret:'private'}}).mockResolvedValueOnce(ok([]));
  await createZohoMailbox(config).list(1,20);expect(clearZohoAccessTokenCache).toHaveBeenCalledTimes(1);
  axios.get.mockRejectedValue({response:{status:403},message:'private-token'});
  await expect(createZohoMailbox(config).list(1,20)).rejects.toThrow('could not be read');
});

const aliasAccount={accountId:'123',primaryEmailAddress:'admin@example.test',emailAddress:[{mailId:'help@example.test'}]};
test('a support alias verifies only its dedicated folder and keeps reads scoped to its exact ID',async()=>{
  axios.get.mockResolvedValueOnce(ok([aliasAccount])).mockResolvedValueOnce(ok([{folderId:'111',folderName:'Inbox'},{folderId:'456',folderName:'LPC Support'}]));
  const mailbox=createZohoMailbox(config);
  await mailbox.verify();
  expect(axios.get.mock.calls.every(([url])=>!url.includes('/messages'))).toBe(true);
  axios.get.mockResolvedValueOnce(ok([]));
  await mailbox.list(1,20);
  expect(axios.get.mock.calls[2][1].params.folderId).toBe('456');
  axios.get.mockResolvedValueOnce(ok({headerContent:{From:['visitor@example.test']}})).mockResolvedValueOnce(ok({content:'Support inquiry'}));
  await mailbox.read({messageId:'789'});
  expect(axios.get.mock.calls.slice(3).every(([url])=>url.includes('/folders/456/messages/789/'))).toBe(true);
});

test.each([
  [[{folderId:'456',folderName:'Inbox'}]],
  [[{folderId:'111',folderName:'LPC Support'},{folderId:'456',folderName:'Inbox'}]],
  [[{folderId:'456',folderName:'Renamed Support'}]],
  [[{folderId:'456',folderName:'LPC Support'},{folderId:'789',folderName:'LPC Support'}]],
  [[{folderId:456,folderName:'LPC Support'}]],
])('rejects alias folder misconfiguration before reading any messages: %j',async folders=>{
  axios.get.mockResolvedValueOnce(ok([aliasAccount])).mockResolvedValueOnce(ok(folders));
  await expect(createZohoMailbox(config).verify()).rejects.toThrow('LPC Support');
  expect(axios.get).toHaveBeenCalledTimes(2);
  expect(axios.get.mock.calls.every(([url])=>!url.includes('/messages'))).toBe(true);
});

test.each([
  [[aliasAccount,{...aliasAccount,accountId:'789'}]],
  [[{...aliasAccount,accountId:123}]],
])('rejects ambiguous or imprecise account identities: %j',async accounts=>{
  axios.get.mockResolvedValueOnce(ok(accounts));
  await expect(createZohoMailbox(config).verify()).rejects.toThrow('does not match');
  expect(axios.get).toHaveBeenCalledTimes(1);
});
