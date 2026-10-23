const router=require('express').Router();
const User=require('../models/User');
const AuditLog=require('../models/AuditLog');
const {csrfProtection}=require('../utils/csrf');
const {withActiveAccountWrite}=require('../utils/activeAccountWrite');
const {validateNewPassword}=require('../utils/passwordPolicy');
const {listActiveSessions,revokeAllUserSessions,revokeSession}=require('../services/authSessionService');
const crypto=require('crypto');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const handle=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(error=>{
  const status=error.statusCode||error.status;
  if([400,401,403,404,409,503].includes(status))return res.status(status).json({error:error.message});
  next(error);
});
async function change(req,work){
 return withActiveAccountWrite([req.user.id],async session=>{
  const user=await User.findById(req.user.id).select('+password +authVersion +twoFactorBackupCodes +twoFactorChallengeHash +twoFactorChallengeAuthVersion +twoFactorTempCode +twoFactorExpiresAt +twoFactorFailedAttempts').session(session);
  if(!user)throw fail(404,'User not found');
  return work(user,session);
 },{ownerId:req.user.id,authVersion:req.authVersion});
}
function clearChallenge(user){
 user.twoFactorChallengeHash=null;user.twoFactorChallengeAuthVersion=null;
 user.twoFactorTempCode=null;user.twoFactorExpiresAt=null;user.twoFactorFailedAttempts=0;
}
const challengePaths=['twoFactorChallengeHash','twoFactorChallengeAuthVersion','twoFactorTempCode','twoFactorExpiresAt','twoFactorFailedAttempts'];
router.post('/update-password',csrfProtection,handle(async(req,res)=>{
 const {currentPassword,newPassword}=req.body||{};
 if(!currentPassword||!newPassword)throw fail(400,'Current and new password are required.');
 await change(req,async(user,session)=>{
  const policy=validateNewPassword(newPassword,{user});if(!policy.ok)throw fail(400,policy.error);
  if(!await user.comparePassword(String(currentPassword)))throw fail(400,'Current password is incorrect.');
  if(await user.comparePassword(policy.password))throw fail(400,'Choose a password you have not already used for this account.');
  user.password=policy.password;user.authVersion=Number(user.authVersion||0)+1;clearChallenge(user);
  await user.save({session,pathsToSave:['password','authVersion',...challengePaths,'updatedAt']});
  await revokeAllUserSessions(user._id,'password_change',{session});
  await AuditLog.logFromReq(req,'account.password.update',{targetType:'user',targetId:user._id,session});
 });
 res.json({ok:true,reauthenticationRequired:true});
}));
router.post('/2fa-toggle',csrfProtection,handle(async(req,res)=>{
 if(String(process.env.ENABLE_TWO_FACTOR||'true').toLowerCase()==='false')throw fail(400,'Two-step verification is currently disabled.');
 const result=await change(req,async(user,session)=>{
  // Preserve the deployed settings form contract; it does not collect a password here.
  if(req.body?.currentPassword&&!await user.comparePassword(String(req.body.currentPassword)))throw fail(400,'Current password is incorrect.');
  const enabled=!!req.body?.enabled,method=String(req.body?.method||user.twoFactorMethod||'email').toLowerCase();
  if(enabled&&!user.emailVerified)throw fail(409,'Verify your email before enabling two-step verification.');
  if(!['email','authenticator','sms'].includes(method))throw fail(400,'Invalid verification method.');
  user.twoFactorEnabled=enabled;user.twoFactorMethod=method;clearChallenge(user);
  if(!enabled)user.twoFactorBackupCodes=[];
  await user.save({session,pathsToSave:['twoFactorEnabled','twoFactorMethod','twoFactorBackupCodes',...challengePaths,'updatedAt']});
  await revokeAllUserSessions(user._id,'two_factor_change',{exceptSessionId:req.authSessionId,session});
  await AuditLog.logFromReq(req,enabled?'account.2fa.enable':'account.2fa.disable',{targetType:'user',targetId:user._id,session});
  return {enabled,method};
 });res.json(result);
}));
router.post('/2fa-backup-codes',csrfProtection,handle(async(req,res)=>{
 if(String(process.env.ENABLE_TWO_FACTOR||'true').toLowerCase()==='false')throw fail(400,'Two-step verification is currently disabled.');
 const codes=await change(req,async(user,session)=>{
  if(!user.twoFactorEnabled)throw fail(409,'Enable two-step verification before generating backup codes.');
  if(req.body?.currentPassword&&!await user.comparePassword(String(req.body.currentPassword)))throw fail(400,'Current password is incorrect.');
  const codes=Array.from({length:Number(process.env.TWO_FA_BACKUP_COUNT||8)},()=>crypto.randomBytes(5).toString('hex').toUpperCase());
  user.twoFactorBackupCodes=codes.map(code=>crypto.createHash('sha256').update(code).digest('hex'));clearChallenge(user);
  await user.save({session,pathsToSave:['twoFactorBackupCodes',...challengePaths,'updatedAt']});
  await AuditLog.logFromReq(req,'account.2fa.backup_codes.rotate',{targetType:'user',targetId:user._id,session});
  return codes;
 });res.json({codes});
}));
router.get('/sessions',handle(async(req,res)=>{
 const sessions=await listActiveSessions(req.user.id);
 res.json({sessions:sessions.map(s=>({id:s.sessionId,createdAt:s.createdAt,lastSeenAt:s.lastSeenAt,expiresAt:s.expiresAt,ua:s.userAgent||'',ip:s.ip||'',current:s.sessionId===req.authSessionId}))});
}));
router.post('/sessions/revoke-others',csrfProtection,handle(async(req,res)=>{
 if(!req.authSessionId)throw fail(409,'Sign in again before managing active sessions.');
 const revokedCount=await change(req,async(user,session)=>revokeAllUserSessions(user._id,'user_revoked_others',{exceptSessionId:req.authSessionId,session}));
 res.json({ok:true,revokedCount});
}));
router.delete('/sessions/:sessionId',csrfProtection,handle(async(req,res)=>{
 const sessionId=String(req.params.sessionId||'');
 await change(req,async(user,session)=>{if(!await revokeSession(sessionId,user._id,'user_revoked',{session}))throw fail(404,'Session not found.');});
 res.json({ok:true,currentSessionRevoked:sessionId===req.authSessionId});
}));
module.exports=router;
