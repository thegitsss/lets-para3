const path=require('node:path'),startBase=require('../payment-summary/real-server.cjs');
module.exports=async options=>{
 const base=await startBase(options),root=path.resolve(__dirname,'../../..'),stripe=require(path.join(root,'utils/stripe')),mongoose=require(path.join(root,'node_modules/mongoose')),User=require(path.join(root,'models/User'));
 process.env.STRIPE_PUBLISHABLE_KEY='pk_test_private_card_fixture';
 const customers=new Map(),intents=new Map(),cards=new Map(),requests=new Map(),restores=[],portalReturns=[];
 const replace=(target,key,fn)=>{const old=target[key];restores.push(()=>target[key]=old);target[key]=fn;};
 const read=(map,id)=>{if(!map.has(id))throw Error('Unknown synthetic provider record');return structuredClone(map.get(id));};
 replace(stripe.customers,'create',async body=>{base.providerCalls.push('customers.create');const value={id:`cus_${body.metadata.userId}`,object:'customer',livemode:false,metadata:body.metadata,invoice_settings:{default_payment_method:null}};customers.set(value.id,value);return structuredClone(value);});
 replace(stripe.customers,'retrieve',async id=>{base.providerCalls.push('customers.retrieve');return read(customers,id);});
 replace(stripe.customers,'update',async(id,patch)=>{base.providerCalls.push('customers.update');const value=read(customers,id);value.invoice_settings=patch.invoice_settings;customers.set(id,value);return structuredClone(value);});
 replace(stripe.setupIntents,'create',async(body,options)=>{base.providerCalls.push('setupIntents.create');if(requests.has(options.idempotencyKey))return read(intents,requests.get(options.idempotencyKey));const id=`seti_${intents.size+1}`;const value={id,object:'setup_intent',livemode:false,status:'requires_payment_method',customer:body.customer,metadata:body.metadata,payment_method:null,client_secret:`${id}_secret_synthetic`};intents.set(id,value);requests.set(options.idempotencyKey,id);return structuredClone(value);});
 replace(stripe.setupIntents,'retrieve',async id=>{base.providerCalls.push('setupIntents.retrieve');return read(intents,id);});
 replace(stripe.paymentMethods,'retrieve',async id=>{base.providerCalls.push('paymentMethods.retrieve');return read(cards,id);});
 replace(stripe.paymentMethods,'attach',async()=>{base.providerCalls.push('paymentMethods.attach');throw Error('An already verified attached card must not be attached again');});
 replace(stripe.billingPortal.sessions,'create',async body=>{base.providerCalls.push('billingPortal.sessions.create');portalReturns.push(body.return_url);read(customers,body.customer);return {id:'bps_synthetic',object:'billing_portal.session',livemode:false,customer:body.customer,url:'https://billing.stripe.com/p/session/synthetic'};});
 return {...base,portalReturns,
  async close(){restores.splice(0).forEach(fn=>fn());await base.close();},
  completeSetup(){const intent=[...intents.values()].at(-1);if(!intent)throw Error('No setup created');const card={id:`pm_${intent.id.slice(5)}`,object:'payment_method',livemode:false,type:'card',customer:intent.customer,card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2029}};cards.set(card.id,card);intent.status='succeeded';intent.payment_method=card.id;return {id:intent.id,status:intent.status};},
  async savedCustomer(ownerId){const user=await User.collection.findOne({_id:new mongoose.Types.ObjectId(ownerId)});return {id:user.stripeCustomerId,record:user.stripeCustomerId?read(customers,user.stripeCustomerId):null};},
 };
};
