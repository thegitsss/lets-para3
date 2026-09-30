const { test, expect } = require('../payment-summary/legacy-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const legacy = require('./legacy-home-fixture');
const current = require('./current-home-fixtures');

async function setup(page, surface) {
  const state = surface === 'original' ? await legacy.install(page, { count: 0 }) : await current.installCurrentHome(page);
  if (surface === 'v2') await current.home(page, '?view=pulse');
  const trigger = page.locator(surface === 'original' ? '[data-action="availability"]' : '[data-v2-availability-trigger]');
  await expect(trigger).toBeEnabled();
  const dialog = page.getByRole('dialog', { name: 'Update availability', exact: true });
  const select = page.locator(surface === 'original' ? '#availabilityStatusInput' : '[data-v2-availability-status]');
  const date = page.locator(surface === 'original' ? '#availabilityDateInput' : '[data-v2-availability-date]');
  const save = page.locator(surface === 'original' ? '#saveAvailabilityBtn' : '[data-v2-availability-save]');
  const ownerId = String(state.profile.id || state.profile._id);
  const writes = [];
  let respond = async route => {
    const body = route.request().postDataJSON();
    Object.assign(state.profile, { availability: body.status === 'available' ? 'Available now' : 'Unavailable', availabilityDetails: { status: body.status, nextAvailable: body.nextAvailable, updatedAt: '2026-09-08T18:00:00Z' } });
    return legacy.json(route, { ownerId, availability: state.profile.availability, availabilityDetails: state.profile.availabilityDetails });
  };
  await page.route('**/api/paralegals/update-availability', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    expect(body.expectedOwnerId).toBe(ownerId); expect(body.expectedValues.availability).toHaveProperty('availabilityDetails.status');
    return respond(route);
  });
  return { state, trigger, dialog, select, date, save, writes, ownerId, setResponse: value => { respond = value; }, open: async () => { await trigger.click(); await expect(dialog).toBeVisible(); }, edit: async () => { await select.selectOption('unavailable'); await date.fill('2026-09-18'); } };
}

for (const surface of ['original', 'v2']) {
  test(`${surface}: changing to available ignores the hidden past return date`, async ({ page }) => {
    const view=await setup(page,surface);await view.open();await view.select.selectOption('unavailable');await view.date.fill('2026-09-07');
    await view.select.selectOption('available');
    if(surface==='v2')expect(await view.dialog.locator('form').evaluate(form=>form.checkValidity())).toBe(true);
    await view.save.click();await expect(view.dialog).not.toBeVisible();expect(view.writes).toHaveLength(1);expect(view.writes[0]).toMatchObject({status:'available',nextAvailable:null});
  });

  test(`${surface}: a confirmed save refreshes another open Home through the shared account signal`, async ({ page, context }) => {
    const view=await setup(page,surface),second=await context.newPage();
    if(surface==='original')await legacy.install(second,{count:0,setup:state=>{state.profile=view.state.profile;}});
    else {await current.installCurrentHome(second,{profile:view.state.profile});await current.home(second,'?view=pulse');}
    const otherTrigger=second.locator(surface==='original'?'[data-action="availability"]':'[data-v2-availability-trigger]');
    await expect(otherTrigger).toContainText('Available now');await view.open();await view.edit();await view.save.click();await expect(view.dialog).not.toBeVisible();
    await second.bringToFront();await expect(otherTrigger).toContainText('Not available',{timeout:15000});expect(view.writes).toHaveLength(1);await second.close();
  });

  test(`${surface}: availability prevents duplicate saves, preserves failed input and confirms the saved projection`, async ({ page }) => {
    const view = await setup(page, surface); let release;
    view.setResponse(async route => { await new Promise(resolve => { release = resolve; }); return legacy.json(route, { error: 'Synthetic temporary failure' }, 503); });
    await view.open(); await view.edit(); await view.save.click(); await expect.poll(() => view.writes.length).toBe(1);
    await expect(view.save).toBeDisabled(); await expect(view.select).toBeDisabled(); await page.keyboard.press('Escape'); await expect(view.dialog).toBeVisible();
    release(); await expect(view.dialog.getByRole('alert')).toContainText('Synthetic temporary failure'); await expect(view.date).toHaveValue('2026-09-18');
    view.setResponse(route => { Object.assign(view.state.profile, { availability: 'Unavailable', availabilityDetails: { status: 'unavailable', nextAvailable: '2026-09-18', updatedAt: '2026-09-08T18:00:00Z' } }); return legacy.json(route, { ownerId: view.ownerId, availability: view.state.profile.availability, availabilityDetails: view.state.profile.availabilityDetails }); });
    await view.save.click(); await expect(view.dialog).not.toBeVisible(); await expect(view.trigger).toContainText('Not available'); expect(view.writes).toHaveLength(2);
    await view.open(); await expect(view.date).toHaveValue('2026-09-18'); await page.keyboard.press('Escape'); await expect(view.trigger).toBeFocused();
  });

  test(`${surface}: an unreadable successful save never invents availability`, async ({ page }) => {
    const view = await setup(page, surface); view.setResponse(route => legacy.json(route, {}));
    await view.open(); await view.edit(); await view.save.click(); await expect(view.dialog.getByRole('alert')).toContainText('could not be confirmed');
    await expect(view.trigger).toContainText('Available now'); await expect(view.date).toHaveValue('2026-09-18'); expect(view.writes).toHaveLength(1);
    await expect(view.dialog.getByRole('button', { name: surface === 'original' ? 'Reload Home' : 'Refresh Home', exact: true })).toBeVisible();
  });

  test(`${surface}: a conflict preserves the edit until explicit refresh loads the current availability`, async ({ page }) => {
    const view = await setup(page, surface); view.setResponse(route => {
      Object.assign(view.state.profile, { availability: 'Unavailable', availabilityDetails: { status: 'unavailable', nextAvailable: '2026-09-22', updatedAt: '2026-09-08T18:00:00Z' } });
      return legacy.json(route, { error: 'This information changed in another session.', code: 'ACCOUNT_CONFLICT' }, 409);
    });
    await view.open(); await view.edit(); await view.save.click(); await expect(view.dialog.getByRole('alert')).toContainText('changed in another session'); await expect(view.date).toHaveValue('2026-09-18');
    let releaseProfile; const gate=new Promise(resolve=>{releaseProfile=resolve;});
    await page.route('**/api/users/me',async route=>{await gate;return legacy.json(route,view.state.profile);});
    try {
      await view.dialog.getByRole('button', { name: surface === 'original' ? 'Reload Home' : 'Refresh Home', exact: true }).click();
      await expect(view.dialog).not.toBeVisible(); await expect(view.trigger).toBeDisabled();
      if (surface === 'v2') {
        // Let the other Home sources paint while the profile stays held.
        // A pointer over the disabled control must not strand this explicit refresh.
        await expect(view.trigger).toContainText('Availability unavailable');
        await view.trigger.hover();
      }
      releaseProfile();
      await expect(view.trigger).toBeEnabled(); await expect(view.trigger).toContainText('Not available');
      await view.open(); await expect(view.date).toHaveValue('2026-09-22'); expect(view.writes).toHaveLength(1);
    } finally { releaseProfile(); }
  });

  test(`${surface}: switching the server account while the dialog is open refuses the write`, async ({ page }) => {
    const view = await setup(page, surface); await view.open(); await view.edit();
    view.state.profile = { ...view.state.profile, id: 'c'.repeat(24), _id: 'c'.repeat(24) };
    await view.save.click();
    if (surface === 'original') { await expect(page.locator('#paralegalHomeView')).toHaveAttribute('data-state','account-changed'); await expect(view.dialog).not.toBeVisible(); }
    else { await expect(view.dialog).not.toBeVisible(); await expect(page).toHaveURL(/login\.html/); }
    expect(view.writes).toEqual([]);
  });

  test(`${surface}: availability dialog has one status control and readable keyboard/mobile/theme states`, async ({ page }, info) => {
    const view = await setup(page, surface);
    for (const [width, theme, scale] of [[1440,'light',1],[390,'light',1],[390,'dark',1],[320,'dark',2]]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(({theme,scale}) => { document.documentElement.classList.toggle('theme-dark',theme==='dark');document.body.classList.toggle('theme-dark',theme==='dark');document.documentElement.style.fontSize=`${16*scale}px`; }, {theme,scale});
      await view.open(); await view.edit(); await expect(view.dialog).not.toContainText('Current status:'); await expect(view.select).toBeEnabled();
      const indicator=await view.select.evaluate(node=>{const style=getComputedStyle(node);return {image:style.backgroundImage,size:style.backgroundSize,repeat:style.backgroundRepeat,position:style.backgroundPosition};});
      expect(indicator.image).not.toBe('none');
      expect(indicator.size.split(',').every(value=>value.trim()==='5px 5px')).toBe(true);
      expect(indicator.repeat.split(',').every(value=>value.trim()==='no-repeat')).toBe(true);
      expect(indicator.position).toBe('calc(100% - 18px) 50%, calc(100% - 13px) 50%');
      const violations = (await new AxeBuilder({page}).include(surface === 'original' ? '#availabilityModal' : '#v2-availability-dialog').analyze()).violations; expect(violations).toEqual([]);
      const clipped = await view.dialog.locator('button,input,select').evaluateAll((nodes,minFont) => nodes.filter(n=>n.offsetParent!==null && (parseFloat(getComputedStyle(n).fontSize)<minFont-0.1 || n.getBoundingClientRect().height<44 || n.getBoundingClientRect().right>innerWidth+1 || n.getBoundingClientRect().left<0)).map(n=>({html:n.outerHTML,height:n.getBoundingClientRect().height,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,font:getComputedStyle(n).fontSize})),14*scale); expect(clipped).toEqual([]);
      await page.screenshot({path:info.outputPath(`${surface}-${width}-${theme}-${scale}.png`)}); await page.keyboard.press('Escape'); await expect(view.dialog).not.toBeVisible(); await expect(view.trigger).toBeFocused();
    }
  });
}
