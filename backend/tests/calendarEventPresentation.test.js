const express=require('express'),request=require('supertest'),crypto=require('node:crypto');
const {connect,clearDatabase,closeDatabase}=require('./helpers/db');
jest.mock('../utils/verifyToken',()=> (req,_res,next)=>next());
jest.mock('../utils/email',()=>jest.fn());
const User=require('../models/User'),Event=require('../models/Event'),Connection=require('../models/CalendarConnection'),Link=require('../models/CalendarSyncLink');
let owner,other;const app=express();app.use(express.json(),(req,_res,next)=>{req.user={id:String(owner._id),role:'attorney',status:'approved'};req.auth={payload:{av:0}};next();});app.use('/api/integrations/calendars',require('../routes/calendarIntegrations'));app.use((e,_req,res,_next)=>res.status(e.status||500).json({error:e.message}));
beforeAll(connect);afterAll(closeDatabase);
beforeEach(async()=>{await clearDatabase();owner=await User.create({firstName:'Sample',lastName:'Owner',email:'calendar-presentation@example.test',password:'Synthetic123!',role:'attorney',status:'approved'});other=await User.create({firstName:'Other',lastName:'Owner',email:'other-calendar-presentation@example.test',password:'Synthetic123!',role:'attorney',status:'approved'});});
test('event presentation identifies only current owner-scoped sync connections without exposing provider identifiers or credentials',async()=>{
 const time={start:new Date('2026-11-09T15:00:00Z'),end:new Date('2026-11-09T16:00:00Z')};const event=await Event.create({owner:owner._id,title:'My private event',...time});await Event.create({owner:other._id,title:'Another person’s private event',...time});
 const own=await Connection.create({ownerId:owner._id,provider:'google',revision:'current',authVersion:0,credentials:'PRIVATE_CREDENTIAL',accountId:'PRIVATE_ACCOUNT'});const foreign=await Connection.create({ownerId:other._id,provider:'microsoft',revision:'foreign',authVersion:0,credentials:'OTHER_CREDENTIAL'});
 for(const [connection,revision]of [[own,'current'],[foreign,'foreign']])await Link.create({connectionId:connection._id,connectionRevision:revision,localId:event._id,kind:'event',remoteId:crypto.randomUUID()});
 const stale=await Connection.create({ownerId:owner._id,provider:'microsoft',revision:'new-account',authVersion:0,credentials:'PRIVATE_STALE'});await Link.create({connectionId:stale._id,connectionRevision:'old-account',localId:event._id,kind:'event',remoteId:crypto.randomUUID()});
 const response=await request(app).get('/api/integrations/calendars/events').query({from:'2026-11-01',to:'2026-11-30'});expect(response.status).toBe(200);expect(response.body.items).toHaveLength(1);expect(response.body.items[0]).toMatchObject({title:'My private event',syncProviders:['google']});expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|OTHER_CREDENTIAL|Another person|accountId|remoteId/);
 await Connection.updateOne({_id:own._id},{$set:{disconnectedAt:new Date()}});const disconnected=await request(app).get('/api/integrations/calendars/events').query({from:'2026-11-01',to:'2026-11-30'});expect(disconnected.status).toBe(200);expect(disconnected.body.items[0].syncProviders).toEqual([]);
});
