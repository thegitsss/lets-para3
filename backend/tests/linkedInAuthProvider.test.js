jest.mock('axios', () => ({get:jest.fn(),post:jest.fn()}));
const axios=require('axios');
const jwt=require('jsonwebtoken');
const crypto=require('crypto');
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
let provider;
beforeEach(()=>{jest.resetModules(); provider=require('../services/linkedInAuthProvider');const http=require('axios');http.get.mockImplementation(async url=>({data:url.includes('/jwks')?{keys:[jwk]}:{sub:'member',email:'member@example.com',email_verified:true}}));});
const token=(claims={},options={})=>jwt.sign({sub:'member',...claims},privateKey,{algorithm:'RS256',keyid:'test-key',issuer:'https://www.linkedin.com/oauth',audience:'client',expiresIn:'5m',...options});
test('configuration requires a separate exact callback and secure production URL',()=>{
 const env={LINKEDIN_CLIENT_ID:'id',LINKEDIN_CLIENT_SECRET:'secret',NODE_ENV:'test'};
 expect(provider.configuration(env)).toBeNull();
 expect(provider.configuration({...env,LINKEDIN_AUTH_REDIRECT_URI:'http://localhost:5051/api/auth/linkedin/callback'})).toBeTruthy();
 expect(provider.configuration({...env,NODE_ENV:'production',LINKEDIN_AUTH_REDIRECT_URI:'http://localhost:5051/api/auth/linkedin/callback'})).toBeNull();
 expect(provider.configuration({...env,LINKEDIN_AUTH_REDIRECT_URI:'https://lpc.invalid/api/uploads/linkedin-photo/callback'})).toBeNull();
});
test('accepts a signed LinkedIn token for the configured application',async()=>expect(await provider.verifyIdentity(token(),'client')).toMatchObject({sub:'member'}));
test.each([
 ['wrong issuer',{}, {issuer:'https://attacker.invalid'}],
 ['wrong audience',{}, {audience:'another-client'}],
 ['expired',{}, {expiresIn:-120}],
 ['wrong authorized party',{azp:'another-client'},{}],
 ['ambiguous audience',{}, {audience:['client','other']}],
 ['future issuance',{iat:Math.floor(Date.now()/1000)+120},{}],
])('rejects %s',async(_,claims,options)=>{await expect(provider.verifyIdentity(token(claims,options),'client')).rejects.toThrow();});
test('rejects an unsigned or forged identity',async()=>{const forged=jwt.sign({sub:'member'},'other-secret',{algorithm:'HS256',keyid:'test-key'});await expect(provider.verifyIdentity(forged,'client')).rejects.toThrow();});
test('checks the signed identity against userinfo before returning it',async()=>{
 const http=require('axios');http.post.mockResolvedValue({data:{access_token:'temporary',id_token:token()}});
 const profile=await provider.exchange('code',{clientId:'client',clientSecret:'secret',redirectUri:'https://lpc.invalid/api/auth/linkedin/callback'});
 expect(profile).toMatchObject({sub:'member',email_verified:true});
 http.get.mockImplementation(async url=>({data:url.includes('/jwks')?{keys:[jwk]}:{sub:'other-member'}}));
 await expect(provider.exchange('code',{clientId:'client',clientSecret:'secret',redirectUri:'https://lpc.invalid/api/auth/linkedin/callback'})).rejects.toThrow('subject mismatch');
});

test('rejects a token without expiry',async()=>{const value=jwt.sign({sub:'member',iss:'https://www.linkedin.com/oauth',aud:'client'},privateKey,{algorithm:'RS256',keyid:'test-key'});await expect(provider.verifyIdentity(value,'client')).rejects.toThrow();});
