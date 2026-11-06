jest.mock('axios', () => Object.assign(jest.fn(), { get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const providers = require('../services/calendar/providers');
const google = { id:'google-event',summary:'Appointment',start:{date:'2026-11-09'},end:{date:'2026-11-10'},etag:'"google-v1"' };
const microsoft = { id:'ms-event',subject:'Appointment',isAllDay:false,start:{dateTime:'2026-11-09T15:00:00',timeZone:'UTC'},end:{dateTime:'2026-11-09T16:00:00',timeZone:'UTC'},transactionId:'stable-id','@odata.etag':'W/"ms-v1"' };
beforeEach(() => jest.resetAllMocks());
test('Google reads every page and expands upcoming recurring occurrences', async () => {
  axios.mockResolvedValueOnce({data:{items:[google],nextPageToken:'page-two'}}).mockResolvedValueOnce({data:{items:[{...google,id:'second'}]}});
  expect(await providers.list('google','synthetic')).toHaveLength(2);
  expect(axios.mock.calls[0][0].url).toContain('singleEvents=true'); expect(axios.mock.calls[1][0].url).toContain('pageToken=page-two');
  expect(axios.mock.calls[0][0].maxRedirects).toBe(0);
});
test('Microsoft follows opaque pagination only on its fixed calendar endpoint', async () => {
  axios.mockResolvedValueOnce({data:{value:[microsoft],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=opaque%2Ftoken'}}).mockResolvedValueOnce({data:{value:[{...microsoft,id:'second'}]}});
  expect(await providers.list('microsoft','synthetic')).toHaveLength(2); expect(axios.mock.calls[1][0].url).toContain('%24skiptoken=opaque%2Ftoken');
  expect(axios.mock.calls[0][0].headers.Prefer).toContain('ImmutableId');
});
test('rejects foreign pagination without forwarding bearer credentials', async () => {
  axios.mockResolvedValue({data:{value:[microsoft],'@odata.nextLink':'https://attacker.invalid/v1.0/me/calendarView?$skip=1'}});
  await expect(providers.list('microsoft','synthetic')).rejects.toThrow('Invalid calendar continuation'); expect(axios).toHaveBeenCalledTimes(1);
});
test('conditional updates retain ETags and never send client-supplied URLs', async () => {
  axios.mockResolvedValue({data:google}); await providers.request('google','synthetic',{method:'PATCH',id:'../../other',etag:'"v1"',body:{summary:'Changed'}});
  expect(axios.mock.calls[0][0].url).toContain('/events/..%2F..%2Fother'); expect(axios.mock.calls[0][0].headers['If-Match']).toBe('"v1"');
});
test('initial OAuth grants must include the requested permissions', async () => {
  axios.post.mockResolvedValue({data:{access_token:'synthetic',expires_in:3600,scope:'openid'}});
  await expect(providers.exchange({token:'https://oauth2.googleapis.com/token',clientId:'client',clientSecret:'secret',scope:'https://www.googleapis.com/auth/calendar.events'},{grant_type:'authorization_code'})).rejects.toThrow('Calendar permission');
});
test('refresh can preserve an existing grant when the provider omits scope', async () => {
  axios.post.mockResolvedValue({data:{access_token:'synthetic',expires_in:3600}});
  expect((await providers.exchange({token:'https://oauth2.googleapis.com/token',clientId:'client',clientSecret:'secret',scope:'calendar'},{grant_type:'refresh_token'})).access_token).toBe('synthetic');
});
test('unavailable calendar identity never exposes HTTP bearer request context', async () => {
  axios.get.mockRejectedValue({config:{headers:{Authorization:'Bearer synthetic-secret'}}});
  await expect(providers.identity('google','synthetic')).rejects.toThrow('Calendar account identity could not be confirmed.');
});

test('retained inclusive LPC all-day dates export with an exclusive end', () => {
  const event={title:'Court date',start:'2026-11-09T00:00:00.000Z',end:'2026-11-09T23:59:59.999Z',isAllDay:true};
  expect(providers.payload('google',event).end).toEqual({date:'2026-11-10'});
  expect(providers.payload('microsoft',event).end.dateTime).toBe('2026-11-10T00:00:00.000');
});
