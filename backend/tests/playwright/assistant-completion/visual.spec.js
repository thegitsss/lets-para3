const {test}=require('./shell-fixture');
const {expect}=require('playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const {prepare,ui,oldUser,oldAnswer}=require('./visual-fixture');
for(const role of ['attorney','paralegal']) {
 for(const shape of [{width:1440,height:1000,theme:'light'},{width:768,height:1000,theme:'light'},{width:390,height:844,theme:'dark'},{width:320,height:720,theme:'dark',enlarged:true}]) {
  test(`${role}: readable Assistant controls and long content at ${shape.width}${shape.enlarged?' enlarged':''}`,async({page},testInfo)=>{
   await page.setViewportSize({width:shape.width,height:shape.height});await page.emulateMedia({reducedMotion:'reduce'});
   const answer={...oldAnswer,text:`The Matter reference is ${'A'.repeat(100)}. Review the recorded information before continuing.`,metadata:{provider:`openai_manager_${role}`}};
   const {open}=await prepare(page,role,{preferences:{theme:shape.theme},history:[oldUser,answer]});
   if(shape.enlarged)await page.evaluate(()=>document.documentElement.style.fontSize='200%');
   if(shape.theme==="dark") await expect(page.locator("html")).toHaveClass(/theme-dark/);
   else await expect(page.locator("html")).not.toHaveClass(/theme-dark/);
   await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
   await expect.poll(()=>ui(page).drawer.evaluate(el=>Math.round(el.getBoundingClientRect().right))).toBeLessThanOrEqual(shape.width+1);
   const geometry=await ui(page).drawer.evaluate(el=>({left:el.getBoundingClientRect().left,width:el.clientWidth,scroll:el.scrollWidth,controls:[...el.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>({label:b.getAttribute('aria-label')||b.textContent.trim(),width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height})),page:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth}));
   expect(geometry.left).toBeGreaterThanOrEqual(-1);expect(geometry.scroll).toBeLessThanOrEqual(geometry.width+1);expect(geometry.page).toBeLessThanOrEqual(geometry.viewport+1);
   if(shape.theme==='dark') {
    const surfaces=await ui(page).drawer.evaluate(el=>[el,el.querySelector('.support-drawer-header'),el.querySelector('.support-composer'),el.querySelector('.support-composer-shell')].map(n=>({name:n.className,color:getComputedStyle(n).backgroundColor})));
    expect(surfaces.filter(s=>{const c=s.color.match(/[\d.]+/g)?.map(Number)||[];return c.length<3||Math.max(...c.slice(0,3))>70||(c.length===4&&c[3]<0.9)})).toEqual([]);
   }
   expect(geometry.controls.filter(b=>b.width<43||b.height<43)).toEqual([]);
   const header=await ui(page).drawer.evaluate(el=>{
    const title=el.querySelector('[data-support-title]').getBoundingClientRect(),actions=el.querySelector('.support-drawer-actions').getBoundingClientRect();
    return {overlap:title.right>actions.left-4 && title.left<actions.right && title.top<actions.bottom && title.bottom>actions.top};
   });
   expect(header.overlap).toBe(false);
   if(shape.enlarged) {
    const heading=await page.locator('[data-support-title]').evaluate(el=>({height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight)}));
    expect(heading.height).toBeLessThanOrEqual(heading.lineHeight*2.1);
    expect(await ui(page).composer.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(28);
   }
   const result=await new AxeBuilder({page}).include('#supportDrawer').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
   expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
   await ui(page).composer.fill('Unsent follow-up');await expect(ui(page).composer).toHaveValue('Unsent follow-up');await expect(page.locator('[data-support-submit]')).toBeEnabled();
   const composer=await ui(page).composer.evaluate(el=>{
    const shell=el.closest('.support-composer-shell'),hint=el.closest('form').querySelector('.support-composer-hint');
    const icon=hint.children[0].getBoundingClientRect(),copy=hint.children[1].getBoundingClientRect();
    return {hintGap:copy.left-icon.right,innerOutline:getComputedStyle(el).outlineStyle,outerOutline:getComputedStyle(shell).outlineStyle};
   });
   expect(composer.hintGap).toBeGreaterThanOrEqual(5);
   expect(composer.innerOutline).toBe('none');expect(composer.outerOutline).toBe('solid');
   await page.screenshot({path:testInfo.outputPath('assistant-layout.png'),fullPage:true});
   await page.keyboard.press('Escape');await expect(ui(page).drawer).toHaveAttribute('aria-hidden','true');
   await expect(page.locator(role==='attorney'?'[data-av2-assistant]':'[data-v2-assistant-trigger]')).toBeFocused();
  });
 }
}


for (const role of ['attorney','paralegal']) test(`${role}: cold account preferences restore Assistant dark surfaces without cached theme`, async ({page}) => {
 const {prepare}=require('./flows-fixture');const f=await prepare(page,role);
 f.sessionState.user.preferences={theme:'dark',fontSize:'md'};
 await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});await page.reload();
 await expect(page.locator('html')).toHaveClass(/theme-dark/);await f.open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
 const surface=await ui(page).drawer.evaluate(el=>getComputedStyle(el).backgroundColor.match(/[\d.]+/g).slice(0,3).map(Number));
 expect(Math.max(...surface)).toBeLessThanOrEqual(70);
});
