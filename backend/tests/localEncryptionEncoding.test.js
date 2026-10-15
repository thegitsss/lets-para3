const crypto=require('crypto');
const saved=process.env.DATA_ENCRYPTION_KEY;
afterEach(()=>{if(saved===undefined)delete process.env.DATA_ENCRYPTION_KEY;else process.env.DATA_ENCRYPTION_KEY=saved;jest.resetModules();});
test('normalizing the same 32-byte Base64 key to hex preserves encrypted data and enables strict security signing',()=>{
 const bytes=crypto.randomBytes(32);process.env.DATA_ENCRYPTION_KEY=bytes.toString('base64');jest.resetModules();const before=require('../utils/dataEncryption');const encrypted=before.encryptString('Existing confidential value');expect(before.isEncrypted(encrypted)).toBe(true);
 process.env.DATA_ENCRYPTION_KEY=bytes.toString('hex');jest.resetModules();const after=require('../utils/dataEncryption');expect(after.isEncryptionEnabled()).toBe(true);expect(after.decryptString(encrypted)).toBe('Existing confidential value');expect(Buffer.from(process.env.DATA_ENCRYPTION_KEY,'hex')).toEqual(bytes);expect(process.env.DATA_ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/);
});
