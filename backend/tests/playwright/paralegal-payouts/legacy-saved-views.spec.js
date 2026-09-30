const {test,expect}=require('playwright/test');
const OWNER='64b000000000000000000001';
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function setup(page){
 const state={views:[],writes:[],failOnce:true};
 await page.route('**/saved-views-fixture.html',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><head><title>Saved application views</title></head><body><label>Views<select id="views"></select></label><button id="save">Save view</button><button id="delete">Delete view</button><p id="status" role="status"></p><script type="module">
 import {mountDashboardSavedViews} from '/assets/scripts/dashboard-saved-views.js';
 window.owner='${OWNER}';window.savedViews=mountDashboardSavedViews({scope:'paralegal_applications',getOwner:()=>window.owner,picker:'#views',saveButton:'#save',deleteButton:'#delete',status:'#status',getState:()=>({search:'discovery',status:'all',practice:'all',dateRange:'all',sort:'newest'})});
 </script></body></html>`}));
 await page.route('**/api/auth/me',route=>json(route,{user:{id:OWNER,_id:OWNER,role:'paralegal',status:'approved',firstName:'Casey',lastName:'Para'}}));
 await page.route('**/api/csrf',route=>json(route,{csrfToken:'synthetic'}));
 await page.route(url=>url.pathname==='/api/account/dashboard-views',route=>{
  if(route.request().method()==='GET'){
   expect(new URL(route.request().url()).searchParams.get('expectedOwnerId')).toBe(OWNER);
   return json(route,{ownerId:OWNER,scope:'paralegal_applications',views:state.views});
  }
  const body=route.request().postDataJSON();state.writes.push(body);expect(body.expectedOwnerId).toBe(OWNER);expect(body.revision).toBeNull();
  if(state.failOnce){state.failOnce=false;return json(route,{error:'Temporarily unavailable'},503);}
  expect(body).toEqual(state.writes[0]);const view={...body,revision:'a'.repeat(64)};state.views=[view];return json(route,{view});
 });
 await page.route('**/api/account/dashboard-views/paralegal_applications/*',route=>{state.writes.push(route.request().postDataJSON());return json(route,{ok:true});});
 await page.goto('/saved-views-fixture.html');await expect(page.locator('#status')).toHaveText('Views sync to your account');return state;
}
test('previous workspace saved views retain retry input and block an account change during deletion',async({page})=>{
 const state=await setup(page);await page.locator('#save').click();const dialog=page.getByRole('dialog');await dialog.getByRole('textbox').fill('Discovery');
 await dialog.getByRole('button',{name:'Save view',exact:true}).click();await expect(dialog).toContainText('Temporarily unavailable');
 await expect(dialog.getByRole('textbox')).toHaveValue('Discovery');await dialog.getByRole('button',{name:'Save view',exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(state.writes).toHaveLength(2);await expect(page.locator('#views')).toHaveValue('saved:'+state.writes[0].id);
 await page.locator('#delete').click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.evaluate(()=>window.owner='64b000000000000000000999');
 await page.getByRole('dialog').getByRole('button',{name:'Delete view',exact:true}).click();await expect(page.locator('#status')).toContainText('Your account changed');expect(state.writes).toHaveLength(2);
});
