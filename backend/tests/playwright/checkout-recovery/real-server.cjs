const path=require('node:path'),startBase=require('../payment-summary/real-server.cjs');
module.exports=async options=>{
 const base=await startBase(options),root=path.resolve(__dirname,'../../..');
 const mongoose=require(path.join(root,'node_modules/mongoose')),User=require(path.join(root,'models/User')),Case=require(path.join(root,'models/Case')),Audit=require(path.join(root,'models/AuditLog')),stripe=require(path.join(root,'utils/stripe'));
 const sessions=new Map(),intents=new Map(),restores=[];
 const replace=(target,key,fn)=>{const old=target[key];restores.push(()=>target[key]=old);target[key]=fn;};
 replace(stripe.checkout.sessions,'retrieve',async id=>{base.providerCalls.push('checkout.sessions.retrieve');if(!sessions.has(id))throw Error('Unknown synthetic Checkout');return structuredClone(sessions.get(id));});
 replace(stripe.checkout.sessions,'create',async()=>{base.providerCalls.push('checkout.sessions.create');throw Error('Checkout creation is outside read/resume acceptance');});
 replace(stripe.paymentIntents,'retrieve',async id=>{base.providerCalls.push('paymentIntents.retrieve');if(!intents.has(id))throw Error('Unknown synthetic intent');return structuredClone(intents.get(id));});
 return {...base,
  async close(){restores.splice(0).forEach(fn=>fn());await base.close();},
  async seedCheckout(ownerId){
   const customer=`cus_${ownerId}`;await User.collection.updateOne({_id:new mongoose.Types.ObjectId(ownerId)},{$set:{stripeCustomerId:customer}});
   const matter=await Case.create({title:'River Street original Checkout',details:'Synthetic original payment recovery.',attorney:ownerId,attorneyId:ownerId,status:'open',totalAmount:40000,lockedTotalAmount:40000,feeAttorneyPct:22,feeAttorneyAmount:8800,currency:'usd',stripeMode:'test',escrowStatus:'pending',escrowSessionId:`cs_test_${ownerId}`});
   const session={id:matter.escrowSessionId,object:'checkout.session',mode:'payment',status:'open',payment_status:'unpaid',amount_total:48800,currency:'usd',livemode:false,customer,payment_intent:null,client_reference_id:String(matter._id),metadata:{caseId:String(matter._id)},ui_mode:'hosted_page',expires_at:Math.floor(Date.now()/1000)+1800,url:`https://checkout.stripe.com/c/pay/${matter.escrowSessionId}#synthetic`};sessions.set(session.id,session);
   const intent={id:`pi_${ownerId}`,object:'payment_intent',status:'succeeded',amount:48800,amount_received:48800,currency:'usd',customer,livemode:false,metadata:{caseId:String(matter._id),attorneyId:ownerId},transfer_group:`case_${matter._id}`};intents.set(intent.id,intent);
   return {id:String(matter._id),session,intent};
  },
  async checkoutEvidence(ownerId){return {...await base.evidence(ownerId),audits:JSON.parse(JSON.stringify(await Audit.collection.find({actor:new mongoose.Types.ObjectId(ownerId)}).sort({_id:1}).toArray()))};},
  async changeMatter(caseId,patch){await Case.collection.updateOne({_id:new mongoose.Types.ObjectId(caseId)},{$set:patch});},
 };
};
