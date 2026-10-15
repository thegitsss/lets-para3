const express=require('express'),cookieParser=require('cookie-parser'),request=require('supertest');
process.env.STRIPE_SECRET_KEY='sk_test_card_billing_synthetic';
const mockStripe={customers:{retrieve:jest.fn(),create:jest.fn(),update:jest.fn()},paymentMethods:{retrieve:jest.fn(),attach:jest.fn()},setupIntents:{retrieve:jest.fn(),create:jest.fn()},billingPortal:{sessions:{create:jest.fn()}},stripeIdempotencyKey:(...parts)=>parts.join('_')};
jest.mock('../utils/stripe',()=>mockStripe);jest.mock('../utils/email',()=>jest.fn(async()=>({ok:true})));
const User=require('../models/User'),{connect,clearDatabase,closeDatabase}=require('./helpers/db');
const app=express();app.use(cookieParser(),express.json());app.use('/api/payments',require('../routes/payments'));
let owner,customer,card,setup;
const cookie=()=>`token=${require('jsonwebtoken').sign({id:String(owner._id),role:'attorney',av:0},process.env.JWT_SECRET,{expiresIn:'1h'})}`;
const read=(legacy=false)=>request(app).get('/api/payments/payment-method/default').query(legacy?{}:{expectedOwnerId:String(owner._id)}).set('Cookie',cookie());
const readSetup=()=>request(app).get(`/api/payments/payment-method/setup-intent/${setup.id}`).query({expectedOwnerId:String(owner._id)}).set('Cookie',cookie());
const save=(legacy=false)=>request(app).post('/api/payments/payment-method/default').set('Cookie',cookie()).send({paymentMethodId:card.id,...legacy?{}:{expectedOwnerId:String(owner._id),intentId:setup.id}});
const portal=(legacy=false)=>request(app).post(legacy?'/api/payments/portal':'/api/payments/portal/attorney').set('Cookie',cookie()).send(legacy?{}:{expectedOwnerId:String(owner._id),requestId:'00000000-0000-4000-8000-000000000001'});
const start=()=>request(app).post('/api/payments/payment-method/setup-intent').set('Cookie',cookie()).set('Idempotency-Key','00000000-0000-4000-8000-000000000002').send({expectedOwnerId:String(owner._id)});
const user=()=>User.collection.findOne({_id:owner._id});
beforeAll(connect);afterAll(closeDatabase);
beforeEach(async()=>{
 await clearDatabase();jest.resetAllMocks();owner=await User.create({firstName:'Synthetic',lastName:'Attorney',email:'card-integrity@example.test',password:'Synthetic123!',role:'attorney',status:'approved',stripeCustomerId:'cus_original'});
 customer={id:'cus_original',object:'customer',livemode:false,metadata:{userId:String(owner._id)},invoice_settings:{default_payment_method:'pm_original'}};
 card={id:'pm_original',object:'payment_method',livemode:false,type:'card',customer:customer.id,card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2029}};
 setup={id:'seti_original',object:'setup_intent',livemode:false,status:'succeeded',customer:customer.id,metadata:{userId:String(owner._id)},payment_method:card.id,usage:'off_session',client_secret:'seti_original_secret_synthetic'};
 mockStripe.customers.retrieve.mockImplementation(async()=>structuredClone(customer));mockStripe.customers.create.mockResolvedValue({...customer,id:'cus_replacement'});mockStripe.customers.update.mockImplementation(async (_id, patch) => ({...structuredClone(customer),invoice_settings:patch.invoice_settings}));mockStripe.paymentMethods.retrieve.mockImplementation(async()=>structuredClone(card));mockStripe.paymentMethods.attach.mockImplementation(async()=>structuredClone(card));mockStripe.setupIntents.retrieve.mockImplementation(async()=>structuredClone(setup));mockStripe.setupIntents.create.mockImplementation(async()=>structuredClone(setup));mockStripe.billingPortal.sessions.create.mockResolvedValue({id:'bps_synthetic',object:'billing_portal.session',livemode:false,customer:customer.id,url:'https://billing.stripe.com/p/session/synthetic'});
});
test('the known saved card and owned successful setup remain readable without a provider write',async()=>{
 const before=await user();expect((await read()).body).toMatchObject({hasDefault:true,paymentMethod:{id:card.id,last4:'4242'}});const result=await readSetup();expect(result.status).toBe(200);expect(result.body).toMatchObject({ownerId:String(owner._id),status:'succeeded',paymentMethod:{id:card.id}});expect(JSON.stringify(result.body)).not.toContain('secret');expect(await user()).toEqual(before);expect(mockStripe.customers.update).not.toHaveBeenCalled();
});
test.each([{id:'cus_foreign'},{livemode:true},{object:'payment_intent'},{invoice_settings:null},{invoice_settings:{default_payment_method:false}},{invoice_settings:{default_payment_method:''}}])('default-card reads reject conflicting customer evidence %j',async patch=>{
 Object.assign(customer,patch);const result=await read();expect([409,502]).toContain(result.status);expect(result.body.paymentMethod).toBeUndefined();expect(result.body.hasDefault).toBeUndefined();expect(mockStripe.customers.create).not.toHaveBeenCalled();
});
test.each([{id:'pm_foreign'},{customer:'cus_foreign'},{livemode:true},{object:'setup_intent'},{card:{brand:'visa',last4:'4242',exp_month:0,exp_year:2029}}])('default-card reads reject conflicting or malformed card evidence %j',async patch=>{
 Object.assign(card,patch);const result=await read();expect([409,502]).toContain(result.status);expect(result.body.paymentMethod).toBeUndefined();expect(result.body.hasDefault).toBeUndefined();
});
test.each([{livemode:true},{object:'payment_intent'},{livemode:undefined}])('setup-return verification rejects unverified provider type/mode %j',async patch=>{
 Object.assign(setup,patch);expect((await readSetup()).status).toBe(409);expect((await save()).status).toBe(409);expect(mockStripe.customers.update).not.toHaveBeenCalled();
});
test('the card is checked again before saving when its provider evidence changes after setup verification',async()=>{
 let reads=0;mockStripe.paymentMethods.retrieve.mockImplementation(async()=>({...card,livemode:++reads>1}));expect((await save()).status).toBe(409);expect(mockStripe.customers.update).not.toHaveBeenCalled();
});
test('legacy card reads also discard the card after current account revocation',async()=>{
 mockStripe.paymentMethods.retrieve.mockImplementationOnce(async()=>{await User.collection.updateOne({_id:owner._id},{$inc:{authVersion:1}});return structuredClone(card);});expect((await read(true)).status).toBe(403);
});
test('legacy default-card writes stop when the signed-in account is revoked during provider lookup',async()=>{
 mockStripe.paymentMethods.retrieve.mockImplementationOnce(async()=>{await User.collection.updateOne({_id:owner._id},{$inc:{authVersion:1}});return structuredClone(card);});expect((await save(true)).status).toBe(403);expect(mockStripe.customers.update).not.toHaveBeenCalled();
});
test.each([true,false])('billing entry legacy=%s rejects another provider mode before creating a session',async legacy=>{
 customer.livemode=true;expect([409,502]).toContain((await portal(legacy)).status);expect(mockStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
});
test('legacy billing cannot return a URL after its account changes during provider handoff',async()=>{
 mockStripe.billingPortal.sessions.create.mockImplementationOnce(async()=>{await User.collection.updateOne({_id:owner._id},{$inc:{authVersion:1}});return {id:'bps_synthetic',url:'https://billing.stripe.com/p/session/synthetic'};});expect((await portal(true)).status).toBe(403);
});
test('legacy billing refuses an untrusted provider session destination',async()=>{
 mockStripe.billingPortal.sessions.create.mockResolvedValueOnce({id:'bps_synthetic',url:'https://billing.stripe.com.evil.test/p/session/synthetic'});expect([409,502,503]).toContain((await portal(true)).status);
});
test('a missing retained customer is not silently replaced while opening setup or billing',async()=>{
 customer.deleted=true;const before=await user();expect([409,502]).toContain((await start()).status);expect([409,502]).toContain((await portal(true)).status);expect(await user()).toEqual(before);expect(mockStripe.customers.create).not.toHaveBeenCalled();expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();expect(mockStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
});
test('a new payment customer is saved before the same owned SetupIntent is returned',async()=>{
 await User.collection.updateOne({_id:owner._id},{$unset:{stripeCustomerId:''}});
 mockStripe.setupIntents.create.mockImplementation(async body=>({...setup,customer:body.customer,status:'requires_payment_method',payment_method:null}));
 const result=await start();expect(result.status).toBe(200);expect(result.body.customerId).toBe('cus_replacement');expect((await user()).stripeCustomerId).toBe('cus_replacement');expect(mockStripe.customers.create).toHaveBeenCalledTimes(1);expect(mockStripe.customers.update).not.toHaveBeenCalled();
});
test.each(['customer','account'])('a concurrent %s change cannot be overwritten by new customer creation',async kind=>{
 await User.collection.updateOne({_id:owner._id},{$unset:{stripeCustomerId:''}});
 mockStripe.customers.create.mockImplementationOnce(async()=>{await User.collection.updateOne({_id:owner._id},{$set:kind==='customer'?{stripeCustomerId:'cus_newer'}:{authVersion:1}});return {...customer,id:'cus_replacement'};});
 expect([403,409]).toContain((await start()).status);expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();expect((await user()).stripeCustomerId).toBe(kind==='customer'?'cus_newer':undefined);
});
test('the final customer reference compare cannot overwrite a newer database value',async()=>{
 await User.collection.updateOne({_id:owner._id},{$unset:{stripeCustomerId:''}});
 const original=User.collection.updateOne.bind(User.collection);const spy=jest.spyOn(User.collection,'updateOne').mockImplementationOnce(async(...args)=>{await original({_id:owner._id},{$set:{stripeCustomerId:'cus_newer'}});return original(...args);});
 try {expect((await start()).status).toBe(409);expect((await user()).stripeCustomerId).toBe('cus_newer');expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
test.each([{id:'cus_foreign'},{livemode:true},{invoice_settings:{default_payment_method:'pm_other'}},null])('a default-card write is not reported saved from conflicting or absent provider acknowledgment %j',async patch=>{
 mockStripe.customers.update.mockResolvedValueOnce(patch===null?null:{...customer,...patch});const result=await save();expect([409,502]).toContain(result.status);expect(result.body.ok).not.toBe(true);expect(mockStripe.customers.update).toHaveBeenCalledTimes(1);
});
test.each([{livemode:true},{object:'customer'},{customer:'cus_foreign'}])('a billing session with conflicting provider evidence is never exposed %j',async patch=>{
 mockStripe.billingPortal.sessions.create.mockResolvedValueOnce({id:'bps_synthetic',object:'billing_portal.session',livemode:false,customer:customer.id,url:'https://billing.stripe.com/p/session/synthetic',...patch});const result=await portal();expect([409,503]).toContain(result.status);expect(result.body.url).toBeUndefined();
});
test('account loss after a default-card provider write is an unavailable outcome, never a success claim',async()=>{
 mockStripe.customers.update.mockImplementationOnce(async()=>{await User.collection.updateOne({_id:owner._id},{$inc:{authVersion:1}});return customer;});expect((await save()).status).toBe(403);expect(mockStripe.customers.update).toHaveBeenCalledTimes(1);
});
