const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../../backend');
const local=name=>require(path.join(root,'node_modules',name));

// Synthetic managed sessions, real account/auth routes and real WebAuthn
// cryptography. No deployed bootstrap, environment file or email provider.
module.exports=async function startSecurityEvidenceServer({frontendRoot=process.env.LPC_SECURITY_FRONTEND_ROOT||path.resolve(root,'../frontend'),port=5289,includeProfileRead=false}={}){
 const origin=`http://localhost:${port}`;
 Object.assign(process.env,{NODE_ENV:'test',JWT_SECRET:'security-browser-local-jwt-secret-at-least-32-bytes',DATA_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',EMAIL_DISABLE:'true',ENABLE_CSRF:'false',APP_BASE_URL:origin,WEBAUTHN_ORIGIN:origin,WEBAUTHN_RP_ID:'localhost',ENABLE_TWO_FACTOR:'true'});
 const mail=[],owners=new Set(),emailPath=require.resolve(path.join(root,'utils/email'));
 require.cache[emailPath]={id:emailPath,filename:emailPath,loaded:true,exports:async(...args)=>{mail.push({subject:args[1]});return{ok:true};}};
 const mongoose=local('mongoose'),express=local('express'),jwt=local('jsonwebtoken'),helmet=local('helmet');
 const {MongoMemoryReplSet}=local('mongodb-memory-server');
 const User=require(path.join(root,'models/User')),AuthSession=require(path.join(root,'models/AuthSession')),AuthChallenge=require(path.join(root,'models/AuthChallenge')),PasskeyCredential=require(path.join(root,'models/PasskeyCredential'));
 const auth=require(path.join(root,'routes/auth')),account=require(path.join(root,'routes/account'));
 const users=includeProfileRead?require(path.join(root,'routes/users')):null;
 const {createAuthSession}=require(path.join(root,'services/authSessionService'));
 const {generateTotpToken}=require(path.join(root,'services/mfaService'));
 const {collectInlineScriptHashes}=require(path.join(root,'utils/contentSecurityPolicy'));
 const replica=await MongoMemoryReplSet.create({replSet:{count:1,ip:'127.0.0.1'},instanceOpts:[{launchTimeout:60000}]});
 await mongoose.connect(replica.getUri('security_browser_isolated'),{autoCreate:false,autoIndex:false});
 for(const Model of Object.values(mongoose.models)){await Model.init();await Model.createCollection();await Model.createIndexes();}
 mongoose.connection.config.autoCreate=true;mongoose.connection.config.autoIndex=true;
 const app=express();app.use(local('cookie-parser')());app.use(express.json({limit:'1mb'}));
 app.use(helmet({contentSecurityPolicy:false,hsts:false,referrerPolicy:{policy:'no-referrer'}}));
 // Same relevant CSP sources as index.js, with local HTTP upgrade disabled.
 app.use(helmet.contentSecurityPolicy({directives:{defaultSrc:["'self'"],scriptSrc:["'self'",...collectInlineScriptHashes(frontendRoot),'https://js.stripe.com','https://challenges.cloudflare.com'],styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com'],frameSrc:["'self'",'https://js.stripe.com','https://hooks.stripe.com','https://challenges.cloudflare.com'],connectSrc:["'self'",'https://api.stripe.com','https://challenges.cloudflare.com'],imgSrc:["'self'",'data:','blob:','https://images.unsplash.com','https://challenges.cloudflare.com'],upgradeInsecureRequests:null}}));
 app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 app.get('/api/csrf',(_req,res)=>res.json({csrfToken:'synthetic-security-csrf'}));
 app.get('/assets/vendor/simplewebauthn-13.3.0.js',(_req,res)=>res.type('application/javascript').sendFile(path.join(root,'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
 app.get('/assets/vendor/web-vitals-6.1.1.js',(_req,res)=>res.type('application/javascript').sendFile(path.join(root,'node_modules/web-vitals/dist/web-vitals.js')));
 app.use('/api',(req,res,next)=>{
  if(includeProfileRead&&req.method==='GET'&&req.path==='/users/me')return next();
  if(/^\/account\/(?:2fa(?:\/authenticator\/(?:setup|confirm)|-toggle|-backup-codes)?|update-password|passkeys(?:\/[\w-]+)?|sessions(?:\/[\w-]+)?)$/.test(req.path)||/^\/auth\/(?:me|login|logout|2fa-verify|2fa-backup)$/.test(req.path))return next();
  if(req.method==='GET'&&['/notifications/stream','/jobs/stream'].includes(req.path)){
   // Match the production stream's lifetime, without producing domain events.
   // Ending each response forces reconnects and unrelated lifecycle refreshes.
   res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive'});
   res.flushHeaders();res.write(': ready\n\n');return;
  }
  if(req.method==='GET')return res.json(req.path.includes('unread-count')?{count:0}:req.path==='/notifications/page'?{items:[],hasMore:false,nextCursor:null}:req.path==='/notifications'?[]:{});
  return res.status(501).json({error:'Outside isolated security evidence scope'});
 });
 app.use('/api/auth',auth);app.use('/api/account',account);if(users)app.use('/api/users',users);app.use(express.static(frontendRoot,{etag:false}));
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'Server error'}));
 const listener=await new Promise((resolve,reject)=>{const server=app.listen(port,'127.0.0.1',()=>resolve(server));server.on('error',reject);});
 async function cookieFor(id,{ua='Mozilla/5.0 Security Evidence Chrome Mac OS',createdAt}={}){
  if(!owners.has(String(id)))throw new Error('Unknown synthetic security account');
  const user=await User.findById(id).select('+authVersion');const record=await createAuthSession(user,{headers:{'user-agent':ua},ip:'192.0.2.10'});
  if(createdAt)await AuthSession.updateOne({sessionId:record.sessionId},{$set:{createdAt}});
  return{name:'token',value:jwt.sign({id:String(user._id),role:user.role,status:user.status,sid:record.sessionId,av:user.authVersion||0},process.env.JWT_SECRET,{expiresIn:'2h'}),url:origin,httpOnly:true,sameSite:'Lax'};
 }
 return{
  origin,password:'A secure current test passphrase',cookieFor,
  async createUser(overrides={}){const user=await User.create({firstName:'Morgan',lastName:'Counsel',email:`security-${crypto.randomUUID()}@example.test`,password:'A secure current test passphrase',role:'attorney',status:'approved',emailVerified:true,preferences:{theme:'light',fontSize:'md'},...overrides});owners.add(String(user._id));return{id:String(user._id),email:user.email,cookie:await cookieFor(user._id)};},
  async updateUser(id,values){if(!owners.has(String(id)))throw new Error('Unknown synthetic security account');await User.collection.updateOne({_id:new mongoose.Types.ObjectId(id)},{$set:values});},
  async inspectUser(id){if(!owners.has(String(id)))throw new Error('Unknown synthetic security account');return User.findById(id).select('_id email lawFirm bio twoFactorEnabled twoFactorMethod +authVersion +twoFactorBackupCodes').lean();},
  async sessions(id){return AuthSession.find({userId:id}).select('sessionId revokedAt revokedReason createdAt').lean();},
  async passkeys(id){return PasskeyCredential.find({userId:id}).select('_id name createdAt').lean();},
  async expireChallenge(challengeId){await AuthChallenge.updateOne({challengeId},{$set:{expiresAt:new Date(0)}});},
  totp:secret=>generateTotpToken(secret).token,
  mailSubjects:()=>mail.map(item=>item.subject),
  async close(){listener.closeAllConnections?.();await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));await mongoose.disconnect();await replica.stop({doCleanup:true,force:true});},
 };
};
