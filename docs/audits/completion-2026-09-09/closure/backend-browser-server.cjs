const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../../backend');
const local=name=>require(path.join(root,'node_modules',name));

// Synthetic managed sessions and actual account closure/auth routes. No
// deployed bootstrap, environment file, live account or email provider.
module.exports=async function startClosureEvidenceServer({frontendRoot=path.resolve(root,'../frontend'),port=5297}={}){
 const origin=`http://localhost:${port}`;
 Object.assign(process.env,{NODE_ENV:'test',JWT_SECRET:'closure-browser-local-jwt-secret-at-least-32-bytes',DATA_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',EMAIL_DISABLE:'true',ENABLE_CSRF:'false',APP_BASE_URL:origin,WEBAUTHN_ORIGIN:origin,WEBAUTHN_RP_ID:'localhost',ENABLE_TWO_FACTOR:'true'});
 const mail=[],owners=new Set(),receipts=[],dropResponses=new Set(),holds=new Map(),emailPath=require.resolve(path.join(root,'utils/email'));
 require.cache[emailPath]={id:emailPath,filename:emailPath,loaded:true,exports:Object.assign(async(...args)=>{mail.push({subject:args[1]});return{ok:true};},{sendAccountDeactivatedEmail:async()=>{mail.push({subject:'Account deactivated'});return{ok:true};}})};
 const mongoose=local('mongoose'),express=local('express'),jwt=local('jsonwebtoken'),helmet=local('helmet');
 const {MongoMemoryReplSet}=local('mongodb-memory-server');
 const User=require(path.join(root,'models/User')),AuthSession=require(path.join(root,'models/AuthSession')),AuthChallenge=require(path.join(root,'models/AuthChallenge')),PasskeyCredential=require(path.join(root,'models/PasskeyCredential'));
 const auth=require(path.join(root,'routes/auth')),account=require(path.join(root,'routes/account'));
 const {createAuthSession}=require(path.join(root,'services/authSessionService'));
 const Case=require(path.join(root,'models/Case')),Job=require(path.join(root,'models/Job')),AuditLog=require(path.join(root,'models/AuditLog')); 
 const {collectInlineScriptHashes}=require(path.join(root,'utils/contentSecurityPolicy'));
 const replica=await MongoMemoryReplSet.create({replSet:{count:1,ip:'127.0.0.1'},instanceOpts:[{launchTimeout:60000}]});
 await mongoose.connect(replica.getUri('closure_browser_isolated'),{autoCreate:false,autoIndex:false});
 for(const Model of Object.values(mongoose.models)){await Model.init();await Model.createCollection();await Model.createIndexes();}
 mongoose.connection.config.autoCreate=true;mongoose.connection.config.autoIndex=true;
 const app=express();app.use(local('cookie-parser')());app.use(express.json({limit:'1mb'}));
 app.use(helmet({contentSecurityPolicy:false,hsts:false,referrerPolicy:{policy:'no-referrer'}}));
 // Same relevant CSP sources as index.js, with local HTTP upgrade disabled.
 app.use(helmet.contentSecurityPolicy({directives:{defaultSrc:["'self'"],scriptSrc:["'self'",...collectInlineScriptHashes(frontendRoot),'https://js.stripe.com','https://challenges.cloudflare.com'],styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com'],frameSrc:["'self'",'https://js.stripe.com','https://hooks.stripe.com','https://challenges.cloudflare.com'],connectSrc:["'self'",'https://api.stripe.com','https://challenges.cloudflare.com'],imgSrc:["'self'",'data:','blob:','https://images.unsplash.com','https://challenges.cloudflare.com'],upgradeInsecureRequests:null}}));
 app.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  const end=res.end,pathname=req.originalUrl.split('?')[0];
  res.end=function(...args){
   if(req.method==='DELETE'&&pathname==='/api/account/deactivate'&&res.statusCode===200){
    const ownerId=String(req.user?.id||'');receipts.push({ownerId,status:200});
    if(dropResponses.delete(ownerId)){req.socket.destroy();return res;}
   }
   return end.apply(this,args);
  };
  next();
 });
 app.use(async(req,_res,next)=>{
  if(req.method==='DELETE'&&req.path==='/api/account/deactivate'){
   try{const payload=jwt.verify(req.cookies.token||'',process.env.JWT_SECRET);const hold=holds.get(String(payload.id));if(hold){hold.entered=true;await hold.promise;}}catch{}
  }
  next();
 });
 app.get('/api/csrf',(_req,res)=>res.json({csrfToken:'synthetic-closure-csrf'}));
 app.get('/assets/vendor/simplewebauthn-13.3.0.js',(_req,res)=>res.type('application/javascript').sendFile(path.join(root,'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
 app.use('/api',(req,res,next)=>{
  if(/^\/account\/(?:deactivate(?:-status|-result)?|delete)$/.test(req.path)||req.path==='/auth/me')return next();
  if(req.method==='GET'&&req.path==='/notifications/stream')return res.type('text/event-stream').send(': ready\n\n');
  if(req.method==='GET')return res.json(req.path.includes('unread-count')?{count:0}:req.path==='/notifications/page'?{items:[],hasMore:false,nextCursor:null}:req.path==='/notifications'?[]:{});
  return res.status(501).json({error:'Outside isolated closure evidence scope'});
 });
 app.use('/api/auth',auth);app.use('/api/account',account);app.use(express.static(frontendRoot,{etag:false}));
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'Server error'}));
 const listener=await new Promise((resolve,reject)=>{const server=app.listen(port,'127.0.0.1',()=>resolve(server));server.on('error',reject);});
 async function cookieFor(id,{ua='Mozilla/5.0 Security Evidence Chrome Mac OS',createdAt}={}){
  if(!owners.has(String(id)))throw new Error('Unknown synthetic closure account');
  const user=await User.findById(id).select('+authVersion');const record=await createAuthSession(user,{headers:{'user-agent':ua},ip:'192.0.2.10'});
  if(createdAt)await AuthSession.updateOne({sessionId:record.sessionId},{$set:{createdAt}});
  return{name:'token',value:jwt.sign({id:String(user._id),role:user.role,status:user.status,sid:record.sessionId,av:user.authVersion||0},process.env.JWT_SECRET,{expiresIn:'2h'}),url:origin,httpOnly:true,sameSite:'Lax'};
 }
 return{
  origin,password:'A secure current test passphrase',cookieFor,
  async createUser(overrides={}){const user=await User.create({firstName:'Morgan',lastName:'Counsel',email:`closure-${crypto.randomUUID()}@example.test`,password:'A secure current test passphrase',role:'attorney',status:'approved',emailVerified:true,preferences:{theme:'light',fontSize:'md'},...overrides});owners.add(String(user._id));return{id:String(user._id),email:user.email,cookie:await cookieFor(user._id)};},
  async updateUser(id,values){if(!owners.has(String(id)))throw new Error('Unknown synthetic closure account');await User.collection.updateOne({_id:new mongoose.Types.ObjectId(id)},{$set:values});},
  async inspectUser(id){if(!owners.has(String(id)))throw new Error('Unknown synthetic closure account');return User.findById(id).select('_id email lawFirm preferences status deleted disabled +authVersion').lean();},
  async sessions(id){return AuthSession.find({userId:id}).select('sessionId revokedAt revokedReason createdAt').lean();},
  async createCase(id,values={}){if(!owners.has(String(id)))throw new Error('Unknown synthetic closure account');return Case.create({title:'Synthetic closure Matter',practiceArea:'probate',details:'Synthetic retained work.',attorney:id,attorneyId:id,status:'open',escrowStatus:'awaiting_funding',paymentStatus:'pending',totalAmount:30000,currency:'usd',...values});},
  async createJob(id,caseId){if(!owners.has(String(id)))throw new Error('Unknown synthetic closure account');return Job.create({attorneyId:id,caseId,title:'Synthetic open posting',practiceArea:'probate',description:'Synthetic retained posting.',budget:300,status:'open'});},
  async inspectCase(id){return Case.findById(id).lean();},
  async inspectJob(id){return Job.findById(id).lean();},
  async audits(id){return AuditLog.find({targetId:id,action:'account.deactivate'}).lean();},
  dropNextResponse(id){if(!owners.has(String(id)))throw new Error('Unknown synthetic closure account');dropResponses.add(String(id));},
  holdNext(id){if(!owners.has(String(id)))throw new Error('Unknown synthetic closure account');let release;const promise=new Promise(resolve=>release=resolve);holds.set(String(id),{promise,release,entered:false});},
  held(id){return holds.get(String(id))?.entered===true;},
  release(id){const hold=holds.get(String(id));holds.delete(String(id));hold?.release();},
  receipts:()=>receipts.map(item=>({...item})),
  mailSubjects:()=>mail.map(item=>item.subject),
  async close(){listener.closeAllConnections?.();await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));await mongoose.disconnect();await replica.stop({doCleanup:true,force:true});},
 };
};
