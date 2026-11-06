const {test:base,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const frontend=path.resolve(__dirname,'../../../../frontend');
const test=base.extend({signupServer:async({},use)=>{
 const server=http.createServer(async(req,res)=>{try{const file=path.resolve(frontend,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(frontend+path.sep))throw Error();const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await use(`http://127.0.0.1:${server.address().port}`);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}});
for(const role of ['attorney','paralegal'])test(`restored two-step signup preserves ${role} validation and registration contract`,async({page,signupServer},info)=>{
 let submissions=[];let fail=true;
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==signupServer)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname==='/api/auth/legal/current')return route.fulfill({json:{documents:{terms:{hash:'a'.repeat(64),url:'/terms.html'},privacy:{hash:'b'.repeat(64),url:'/privacy.html'}}}});
  if(url.pathname==='/api/csrf')return route.fulfill({json:{csrfToken:'synthetic'}});
  if(url.pathname==='/api/auth/register'){submissions.push(route.request().postData());return route.fulfill({status:fail?503:200,json:fail?{error:'Synthetic unavailable'}:{emailVerified:false,verificationEmailStatus:'sent'}});}
  return route.fulfill({status:401,json:{error:'Not signed in'}});
 });
 await page.goto(signupServer+'/signup.html?role='+role);await page.evaluate(()=>document.fonts.ready);
 await expect(page.locator('#fullName')).toBeVisible();await expect(page.locator('#nextStepBtn')).toBeVisible();await expect(page.locator('#submitBtn')).toBeHidden();
 await page.locator('#nextStepBtn').click();await expect(page.locator('#fullNameError')).toBeVisible();expect(submissions).toEqual([]);
 await page.locator('#fullName').fill('Morgan Applicant');await page.locator('#email').fill(role+'@example.com');await page.locator('#password').fill('Eight character private password');
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.screenshot({path:info.outputPath(`${role}-step-1-${width}.png`),fullPage:true});}
 await page.locator('#nextStepBtn').click();await expect(page.locator('#stepTwoPanel')).toBeVisible();await expect(page.locator('#stepOnePanel')).toBeHidden();
 if(role==='attorney'){await page.locator('#bar').fill('NY12345');await page.locator('#barState').selectOption('NY');await page.locator('#attorneyGoodStanding').check();await page.locator('#attorneyPricingAccepted').check();}
 else {await page.locator('#signupState').selectOption('NY');await page.locator('#resumeUpload').setInputFiles({name:'resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nsynthetic')});await page.locator('#btnA').click();await expect(page.locator('#stepTwoPanel')).toBeVisible();await page.locator('#bar').fill('NY98765');await page.locator('#btnP').click();await expect(page.locator('#stepTwoPanel')).toBeVisible();expect(await page.locator('#resumeUpload').evaluate(e=>e.files[0].name)).toBe('resume.pdf');await expect(page.locator('#signupState')).toHaveValue('NY');}
 const stateSelector=page.locator(role==='attorney'?'#barState':'#signupState');await expect(stateSelector).toHaveValue('NY');expect(await stateSelector.evaluate(el=>({tag:el.tagName,options:el.options.length,placeholder:el.options[0].textContent}))).toEqual({tag:'SELECT',options:52,placeholder:role==='attorney'?'Select state':'State'});
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(width=>{document.documentElement.style.fontSize=width===320?'125%':'100%';},width);await page.locator('#submitBtn').scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`${role}-step-2-${width}.png`),fullPage:true});}
 await page.evaluate(()=>{const token=document.createElement('input');token.type='hidden';token.name='cf-turnstile-response';token.value='synthetic-challenge';document.querySelector('#signupForm').append(token);});
 await page.locator('#submitBtn').click();await expect(page.locator('#msg')).toContainText('Synthetic unavailable');expect(await page.locator('#email').inputValue()).toBe(role+'@example.com');
 fail=false;await page.locator('#submitBtn').click();await expect(page.locator('#signupConfirmation')).toBeVisible();expect(submissions).toHaveLength(2);expect(submissions[1]).toContain(role);expect(submissions[1]).toContain('termsAccepted');expect(submissions[1]).toMatch(/name="state"\r\n\r\nNY\r\n/);if(role==='attorney'){expect(submissions[1]).toMatch(/name="barState"\r\n\r\nNY\r\n/);expect(submissions[1]).toMatch(/name="attorneyPricingAccepted"\r\n\r\ntrue\r\n/);}else expect(submissions[1]).toContain('resume.pdf');
});
