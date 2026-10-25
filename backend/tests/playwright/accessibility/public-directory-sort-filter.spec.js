const { test, expect } = require('playwright/test');
const viewports = [320,390,768,1366,1920];
async function install(page) {
 const queries=[];
 await page.route('**/api/auth/me',r=>r.fulfill({json:{user:null}}));
 await page.route('**/api/csrf',r=>r.fulfill({json:{csrfToken:'directory-checkboxes'}}));
 await page.route('**/public/paralegals?**',r=>{queries.push(new URL(r.request().url()).searchParams.toString());return r.fulfill({json:{items:[],total:0,page:1,pages:1}});});
 return queries;
}
async function open(page,width=390) {
 await page.setViewportSize({width,height:844});await page.goto('/browse-paralegals.html');await expect(page.locator('#resultsStatus')).toContainText('No paralegals match');
}
async function queryIs(queries, expected) {
 await expect.poll(()=>{const q=new URLSearchParams(queries.at(-1));return Object.fromEntries(Object.keys(expected).map(k=>[k,q.get(k)]));}).toEqual(expected);
}
async function bounds(page,selector) {
 const box=await page.locator(selector).boundingBox(),viewport=page.viewportSize();
 expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width+1);
 expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height+1);
}

test('ordering control offers only name and experience and opens by keyboard',async({page})=>{
 const queries=await install(page);
 for(const width of viewports){
  await open(page,width);await queryIs(queries,{sort:'alpha'});
  const trigger=page.locator('#sortMenuTrigger'),menu=page.locator('#sortMenuOptions');
  await expect(trigger).toHaveAccessibleName('Sort paralegals: Name A–Z');
  await trigger.click();await bounds(page,'#sortMenuOptions');
  const ordering=menu.getByRole('combobox',{name:'Order paralegals'});
  await expect(ordering.locator('option')).toHaveText(['Name A–Z','Most experience']);
  await expect(menu).not.toContainText(/newest|recent|date/i);await expect(ordering).toHaveValue('alpha');
  await ordering.selectOption('experience');await queryIs(queries,{sort:'experience'});
  await expect(trigger).toBeFocused();await expect(menu).toBeHidden();
  await trigger.press('ArrowDown');await expect(ordering).toBeFocused();
  expect(await ordering.evaluate(select=>{
   const style=getComputedStyle(select),context=document.createElement('canvas').getContext('2d');
   context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
   return context.measureText(select.selectedOptions[0].textContent).width <= select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
  })).toBe(true);
  await ordering.selectOption('alpha');await queryIs(queries,{sort:'alpha'});
  await trigger.press('Space');await expect(menu).toBeVisible();await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(trigger).toBeFocused();
 }
});

test('filled filter controls, checkbox choices, experience control and removable chips combine without changing sort',async({page})=>{
 test.setTimeout(90000);const queries=await install(page);
 for(const width of viewports){
  await open(page,width);await page.locator('#filterToggle').click();await bounds(page,'#filterMenu');
  const menu=page.locator('#filterMenu'),specialties=menu.getByRole('group',{name:'Specialty choices'}),states=menu.getByRole('group',{name:'State choices'});
  await expect(menu.getByRole('combobox',{name:'Minimum experience'})).toBeVisible();
  await expect(menu.getByText('Advanced filters',{exact:true})).toHaveCount(0);
  await expect(menu.getByRole('button',{name:'Specialty',exact:true})).toHaveAttribute('aria-expanded','false');
  await menu.getByRole('button',{name:'Specialty',exact:true}).click();
  await expect(specialties.getByRole('checkbox')).toHaveCount(42);
  await menu.getByRole('searchbox',{name:'Search specialties'}).fill('contract');
  await expect(specialties.getByRole('checkbox')).toHaveCount(1);await specialties.getByRole('checkbox',{name:'Contract Law',exact:true}).check();
  await queryIs(queries,{practice:'Contract Law',sort:'alpha'});
  await menu.getByRole('button',{name:'State',exact:true}).click();
  await expect(specialties).toBeVisible();await expect(states).toBeVisible();
  await expect(states.getByRole('checkbox')).toHaveCount(51);
  const stateSearch=menu.getByRole('searchbox',{name:'Search states'});
  await stateSearch.fill('new');await expect(states.getByRole('checkbox')).toHaveCount(4);
  await states.getByRole('checkbox',{name:'New York',exact:true}).check();await states.getByRole('checkbox',{name:'New Jersey',exact:true}).check();
  await queryIs(queries,{location:'New York|New Jersey',practice:'Contract Law'});
  await stateSearch.fill('no-such-state');await expect(states.getByRole('status')).toHaveText('No matching choices.');
  await stateSearch.fill('new');await expect(states.getByRole('checkbox',{name:'New York',exact:true})).toBeChecked();
  await menu.getByRole('button',{name:'Specialty, 1 selected',exact:true}).click();
  await expect(specialties).toBeHidden();await queryIs(queries,{practice:'Contract Law'});
  await menu.getByRole('combobox',{name:'Minimum experience'}).selectOption('3');
  await queryIs(queries,{minYears:'3',practice:'Contract Law',location:'New York|New Jersey',sort:'alpha'});
  await bounds(page,'#filterMenu');
  await menu.getByRole('button',{name:'Done',exact:true}).click();await expect(menu).toBeHidden();await expect(page.locator('#filterToggle')).toBeFocused();
  await expect(page.locator('#activeDirectoryFilters').getByRole('button')).toHaveCount(4);
  await page.getByRole('button',{name:'Remove State: New Jersey',exact:true}).click();await queryIs(queries,{location:'New York',practice:'Contract Law',minYears:'3'});
  await page.getByRole('button',{name:'Remove State: New York',exact:true}).click();
  await queryIs(queries,{location:null,practice:'Contract Law',minYears:'3',sort:'alpha'});await expect(states).toBeHidden();
  await page.locator('#filterToggle').click();await menu.getByRole('button',{name:'Clear all filters'}).click();await queryIs(queries,{location:null,practice:null,minYears:null,sort:'alpha'});
  await expect(page.locator('#activeDirectoryFilters')).toBeHidden();await menu.getByRole('button',{name:'Done',exact:true}).click();
 }
});

test('checkbox sections support keyboard selection, Escape collapse and outside-click dismissal',async({page})=>{
 const queries=await install(page);await open(page,390);
 await page.locator('#filterToggle').click();const menu=page.locator('#filterMenu');
 await menu.getByRole('button',{name:'Specialty',exact:true}).click();
 const search=menu.getByRole('searchbox',{name:'Search specialties'});
 await search.fill('Family Law');await search.press('ArrowDown');await page.keyboard.press('Space');
 await expect(menu.getByRole('checkbox',{name:'Family Law',exact:true})).toBeChecked();await queryIs(queries,{practice:'Family Law'});
 await page.keyboard.press('Escape');await expect(menu.getByRole('button',{name:'Specialty, 1 selected'})).toBeFocused();
 await expect(menu).toBeVisible();await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(page.locator('#filterToggle')).toBeFocused();
 await page.locator('#sortMenuTrigger').click();await page.locator('#filterToggle').click();await expect(page.locator('#sortMenuOptions')).toBeHidden();
 await page.mouse.click(2,500);await expect(menu).toBeHidden();
});

test('mobile touch can open ordering, expand a checkbox section and keep the panel in the viewport',async({browser},testInfo)=>{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,...(testInfo.project.name!=='firefox'?{isMobile:true}:{})});
 try{const page=await context.newPage();await install(page);await open(page);
 await page.locator('#sortMenuTrigger').tap();await page.getByRole('combobox',{name:'Order paralegals'}).selectOption('experience');
 await page.locator('#filterToggle').tap();const menu=page.locator('#filterMenu');await menu.getByRole('button',{name:'State',exact:true}).tap();
 await menu.getByRole('searchbox',{name:'Search states'}).fill('New York');await menu.getByRole('checkbox',{name:'New York',exact:true}).tap();await expect(menu.getByRole('checkbox',{name:'New York',exact:true})).toBeChecked();
 await bounds(page,'#filterMenu');await menu.getByRole('button',{name:'Done',exact:true}).tap();await expect(menu).toBeHidden();
 }finally{await context.close();}
});
