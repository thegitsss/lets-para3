const {chromium,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../frontend');
const out=path.resolve(__dirname,'../../docs/audits/assistant-compact-2026-09-28');fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch();try{
for(const width of [1366,390]) for(const theme of ['light','dark']){
const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390});const page=await context.newPage();const errors=[];let feedback=0;
const user={id:'507f1f77bcf86cd799439011',firstName:'Test',role:'attorney',status:'approved'};
let message={id:'507f1f77bcf86cd799439012',sender:'assistant',text:'I can help you find a paralegal or check your matter. What would you like to do?',createdAt:new Date().toISOString(),metadata:{}};
await page.addInitScript(({user,theme})=>{localStorage.setItem('lpc_user',JSON.stringify(user));window.testTheme=theme;Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.testCopy=text},configurable:true});},{user,theme});
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!=='http://lpc.test')return route.abort();
if(u.pathname.endsWith('/feedback')){feedback++;message={...message,metadata:{feedback:{rating:route.request().postDataJSON().rating}}};return route.fulfill({json:{message}});}
if(u.pathname.endsWith('/messages'))return route.fulfill({json:{messages:[message],conversation:{id:"507f1f77bcf86cd799439013",status:"active"}}});
if(u.pathname==='/api/support/conversation')return route.fulfill({json:{conversation:{id:'507f1f77bcf86cd799439013',status:'active'}}});
if(u.pathname.endsWith('/events'))return route.fulfill({status:204});
if(u.pathname.startsWith('/api/'))return route.fulfill({json:{csrfToken:'test',user}});
const file=path.join(root,u.pathname);if(fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file,contentType:/\.(mjs|js)$/.test(file)?'text/javascript':undefined});
return route.fulfill({contentType:'text/html',body:'<html><head><style>body{margin:0}button svg{width:100%;height:auto}</style></head><body data-public-page="true"><main>Workspace</main><script>if(window.testTheme==="dark")document.documentElement.classList.add("theme-dark")</script></body></html>'});});
await page.goto('http://lpc.test/assistant-check');
await page.evaluate(async()=>{const m=await import('/assets/scripts/utils/support-drawer.js');await m.openSupportDrawer();});
await expect(page.locator('.support-message-utility')).toHaveCount(3);
for(const svg of await page.locator('.support-message-utility svg').all()){const box=await svg.boundingBox();expect(box.width).toBe(16);expect(box.height).toBe(16);}
const button=await page.locator('.support-message-utility').first().boundingBox();expect(button.width).toBe(width===390?44:32);
await page.getByRole('button',{name:'Copy',exact:true}).click();expect(await page.evaluate(()=>window.testCopy)).toBe(message.text);
await page.getByRole('button',{name:'Helpful',exact:true}).click();await expect(page.getByRole('button',{name:'Helpful',exact:true})).toHaveAttribute('aria-pressed','true');expect(feedback).toBe(1);
expect(await page.locator('#supportDrawer').evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
await page.screenshot({path:path.join(out,`${width}-${theme}.png`)});
expect(errors).toEqual([]);await context.close();console.log(`${width}px ${theme}: 16px icons, compact controls, copy and feedback passed`);
}
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
