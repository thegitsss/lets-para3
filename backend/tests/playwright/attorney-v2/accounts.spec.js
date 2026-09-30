const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const id = "aaaaaaaaaaaaaaaaaaaaaaaa", other = "bbbbbbbbbbbbbbbbbbbbbbbb";
const photoRevision = "a".repeat(64);
const initial = () => ({_id:id,firstName:"Morgan",lastName:"Ellis",email:"morgan@example.test",pendingEmail:"",phoneNumber:"2125550100",lawFirm:"Ellis Legal",firmWebsite:"https://example.test",linkedInURL:"https://linkedin.com/in/morgan",state:"NY",barNumber:"NY123",timezone:"America/New_York",bio:"Practical legal support.",about:"Retained legacy description",practiceAreas:["Contracts"],specialties:[],publications:["A guide to contracts"],languages:[{name:"English",proficiency:"Native"}],experience:[{title:"Attorney",years:"2020–present",description:"Commercial practice"}],yearsExperience:6,profileImage:"",avatarURL:"",profilePhotoRevision:photoRevision,preferences:{theme:"light",fontSize:"md",hideProfile:false},notificationPrefs:{inApp:true,inAppMessages:true,inAppCase:true,email:true,emailMessages:true,emailCase:true},retainedField:"keep"});
const json = (route,value,status=200) => route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
async function setup(page, overrides={}) {
  const model={profile:{...initial(),...overrides},owner:id,writes:[],profileFail:false,saveFail:false,preferenceFail:false,delaySave:null,publicCalls:0,originalCalls:0};
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname,method=request.method();
    if(pathname==="/api/auth/me")return model.authFail?json(route,{},503):json(route,{user:{id:model.owner,role:"attorney",status:"approved",firstName:model.profile.firstName,lastName:model.profile.lastName,preferences:model.profile.preferences}});
    if(pathname==="/api/auth/workspace-release")return json(route,{workspace:{schemaVersion:1,ownerId:model.owner,role:"attorney",revision:1,version:"v2",defaultDestination:"/attorney-v2.html#/home"}});
    if(pathname==="/api/csrf")return json(route,{csrfToken:"synthetic-token"});
    if(pathname==="/api/users/me"&&method==="GET")return model.profileFail?json(route,{error:"Unavailable"},503):json(route,model.profile);
    if(pathname===`/api/users/attorneys/${id}`){model.publicCalls++;return json(route,{id,name:`${model.profile.firstName} ${model.profile.lastName}`,firstName:model.profile.firstName,lastName:model.profile.lastName,lawFirm:model.profile.lawFirm,firmWebsite:model.profile.firmWebsite,linkedInURL:model.profile.linkedInURL,practiceDescription:model.profile.bio||model.profile.about,languages:model.profile.languages,profileImage:model.profile.profileImage,experience:model.profile.experience,practiceAreas:model.profile.practiceAreas,specialties:["Commercial law"],publications:model.profile.publications,yearsExperience:model.profile.yearsExperience,location:model.profile.state});}
    if(pathname==="/api/users/me"&&method==="PATCH"){
      const body=request.postDataJSON();model.writes.push({path:pathname,body});if(model.delaySave)await model.delaySave;
      if(body.expectedOwnerId!==model.owner)return json(route,{code:"ACCOUNT_CHANGED"},403);
      if(model.saveFail)return json(route,{error:"Unavailable"},503);
      for(const [key,value] of Object.entries(body.expectedValues||{}))if(JSON.stringify(model.profile[key]??"")!==JSON.stringify(value))return json(route,{code:"ACCOUNT_CONFLICT"},409);
      if(body.avatarURL!==undefined){if(body.expectedPhotoRevision!==model.profile.profilePhotoRevision)return json(route,{code:"ACCOUNT_CONFLICT"},409);model.profile.avatarURL="";model.profile.profileImage="";model.profile.profilePhotoRevision="b".repeat(64);}
      for(const [key,value] of Object.entries(body))if(!["expectedOwnerId","expectedValues","expectedPhotoRevision","avatarURL"].includes(key)){if(key==="email")model.profile.pendingEmail=value;else {model.profile[key]=value;if(key==="bio")model.profile.about=value;if(key==="practiceAreas")model.profile.specialties=value;}}
      if(model.saveLost){model.saveLost=false;return route.abort("failed");}return json(route,model.profile);
    }
    if(pathname==="/api/account/preferences"&&method==="POST"){
      const body=request.postDataJSON();model.writes.push({path:pathname,body});if(model.preferenceFail)return json(route,{},503);
      if(body.expectedOwnerId!==model.owner)return json(route,{code:"ACCOUNT_CHANGED"},403);
      for(const key of ["theme","fontSize"])if(Object.hasOwn(body,key)){if(body.expectedValues[key]!==model.profile.preferences[key])return json(route,{code:"ACCOUNT_CONFLICT"},409);model.profile.preferences[key]=body[key];}
      if(model.preferenceLost){model.preferenceLost=false;return route.abort("failed");}return json(route,{success:true,preferences:model.profile.preferences});
    }
    if(pathname==="/api/users/me/notification-prefs"){
      const body=request.postDataJSON();model.writes.push({path:pathname,body});if(model.preferenceFail)return json(route,{},503);
      for(const key of Object.keys(model.profile.notificationPrefs))if(Object.hasOwn(body,key))model.profile.notificationPrefs[key]=body[key];return json(route,{notificationPrefs:model.profile.notificationPrefs,updatedAt:new Date().toISOString()});
    }
    if(pathname==="/api/uploads/profile-photo/original"){model.originalCalls++;return route.fulfill({status:200,contentType:"image/png",body:Buffer.from(model.png||"", "base64")});}
    if(pathname==="/api/uploads/profile-photo"&&method==="POST"){
      model.writes.push({path:pathname,body:request.postData()});if(model.photoFail)return json(route,{},503);model.profile.profileImage=`/api/users/profile-photo/${id}?v=2`;model.profile.avatarURL=model.profile.profileImage;model.profile.profilePhotoRevision="b".repeat(64);return json(route,{success:true,status:"approved",profileImage:model.profile.profileImage,profilePhotoRevision:model.profile.profilePhotoRevision});
    }
    if(pathname.startsWith("/api/users/profile-photo/"))return route.fulfill({status:200,contentType:"image/png",body:Buffer.from(model.png||"", "base64")});
    if(pathname==="/api/notifications/page")return json(route,{items:[],hasMore:false,nextCursor:null});
    if(pathname==="/api/notifications/unread-count")return json(route,{count:0});
    if(pathname==="/api/notifications")return json(route,[]);
    if(pathname==="/api/notifications/stream")return route.fulfill({status:200,contentType:"text/event-stream",body:": ready\n\n"});
    return json(route,{});
  });
  return model;
}
async function open(page, tab = "") {
  // Firefox can retain its navigation wait after this document has rendered.
  // Use native entry and verify the actual destination and account readiness.
  const destination = new URL(`/attorney-v2.html#/settings${tab ? `?tab=${tab}` : ""}`, test.info().project.use.baseURL);
  await page.evaluate(url => { setTimeout(() => location.assign(url), 0); }, destination.href);
  await expect.poll(() => { const current = new URL(page.url()); return current.origin + current.pathname; }).toBe(destination.origin + destination.pathname);
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  await expect(page.locator("[data-account-content]")).toHaveAttribute("aria-busy", "false");
}
async function openStorageSender(sender) {
  const destination=new URL("/robots.txt",test.info().project.use.baseURL);
  const response=sender.waitForResponse(value=>value.url()===destination.href&&value.request().isNavigationRequest());
  await sender.evaluate(url=>{setTimeout(()=>location.assign(url),0);},destination.href);
  expect((await response).status()).toBe(200);await expect(sender).toHaveURL(destination.href);
}
test("loads private profile once, keeps labels without duplicate placeholders, and saves only changed fields",async({page})=>{
  const model=await setup(page);await open(page);await expect(page.getByLabel("Bar number",{exact:true})).toHaveValue("NY123");await expect(page.getByLabel("Time zone",{exact:true})).toHaveValue("America/New_York");
  expect(await page.locator("[data-account-profile-form] [placeholder]").count()).toBe(0);
  await page.getByLabel("Firm",{exact:true}).fill("Updated Legal");await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect(page.getByText("Changes saved.",{exact:true})).toBeVisible();
  expect(model.writes[0].body).toEqual({lawFirm:"Updated Legal",expectedOwnerId:id,expectedValues:{lawFirm:"Ellis Legal"}});expect(model.profile.retainedField).toBe("keep");await page.reload();await expect(page.getByLabel("Firm",{exact:true})).toHaveValue("Updated Legal");
});
test("retains draft across local navigation and cancels all unsaved values",async({page})=>{
  await setup(page);await open(page);await page.getByLabel("Firm",{exact:true}).fill("Draft Firm");await page.getByRole("navigation",{name:"Profile settings"}).getByRole("link",{name:"Preferences",exact:true}).click();await page.getByRole("navigation",{name:"Profile settings"}).getByRole("link",{name:"Profile",exact:true}).click();await expect(page.getByLabel("Firm",{exact:true})).toHaveValue("Draft Firm");await page.getByRole("button",{name:"Cancel changes"}).click();await expect(page.getByLabel("Firm",{exact:true})).toHaveValue("Ellis Legal");
});
test("failed save preserves edits and retry never writes unrelated fields",async({page})=>{
  const model=await setup(page);await open(page);model.saveFail=true;await page.getByLabel("About your practice").fill("A revised bio.");await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect(page.getByText("The save could not be confirmed. Your changes are still here.")).toBeVisible();await expect(page.getByLabel("About your practice")).toHaveValue("A revised bio.");model.saveFail=false;await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect(page.getByText("Changes saved.",{exact:true})).toBeVisible();expect(model.writes).toHaveLength(2);expect(Object.keys(model.writes[1].body).sort()).toEqual(["bio","expectedOwnerId","expectedValues"]);
});
test("failed profile readback keeps the draft and prevents another write until verification",async({page})=>{
  const model=await setup(page);await open(page);
  await page.getByLabel("Firm",{exact:true}).fill("Retained firm edit");model.saveFail=true;model.profileFail=true;
  const save=page.getByRole("button",{name:"Save changes",exact:true});await save.click();
  await expect(save).toBeEnabled();await expect(page.getByLabel("Firm",{exact:true})).toHaveValue("Retained firm edit");
  expect(model.writes).toHaveLength(1);await save.click();
  await expect(page.getByText("The last save is still unconfirmed. Refresh your account before trying again.",{exact:true})).toBeVisible();
  expect(model.writes).toHaveLength(1);model.profileFail=false;model.saveFail=false;await save.click();
  await expect(page.getByText("Changes saved.",{exact:true})).toBeVisible();expect(model.writes).toHaveLength(2);
  expect(model.writes[1].body.expectedValues.lawFirm).toBe("Ellis Legal");
});
test("failed photo readback retains the selected image and original revision for deliberate retry",async({page})=>{
  const model=await setup(page);await open(page);
  model.png=await page.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=600;canvas.height=400;return canvas.toDataURL("image/png").split(",")[1];});
  await page.getByLabel("Choose profile photo",{exact:true}).setInputFiles({name:"retained.png",mimeType:"image/png",buffer:Buffer.from(model.png,"base64")});
  const dialog=page.getByRole("dialog",{name:"Edit profile photo"}),save=dialog.getByRole("button",{name:"Save photo",exact:true});
  model.photoFail=true;model.profileFail=true;await save.click();
  await expect(dialog).toContainText("The save could not be confirmed.");await expect(save).toBeEnabled();
  expect(model.writes).toHaveLength(1);await expect(dialog.getByRole("img",{name:"Photo crop preview"})).toBeVisible();
  model.photoFail=false;model.profileFail=false;await save.click();await expect(dialog).toHaveCount(0);
  expect(model.writes).toHaveLength(2);expect(model.writes[1].body).toContain(photoRevision);
});
test("an edit typed while saving survives the response and is saved on the next action",async({page})=>{
  const model=await setup(page);await open(page);let resolve;model.delaySave=new Promise(r=>{resolve=r;});await page.getByLabel("Firm",{exact:true}).fill("First Edit");await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect.poll(()=>model.writes.length).toBe(1);await page.getByLabel("Firm",{exact:true}).fill("Second Edit");resolve();model.delaySave=null;await expect(page.getByText("Unsaved changes",{exact:true})).toBeVisible();await expect(page.getByLabel("Firm",{exact:true})).toHaveValue("Second Edit");await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect.poll(()=>model.profile.lawFirm).toBe("Second Edit");expect(model.writes[1].body.expectedValues.lawFirm).toBe("First Edit");
});
test("same-field conflicts show latest values and require a deliberate resolution",async({page})=>{
  const model=await setup(page);await open(page);await page.getByLabel("Firm",{exact:true}).fill("My Edit");model.profile.lawFirm="Another Session";await page.getByRole("button",{name:"Save changes",exact:true}).click();await page.getByRole("button",{name:"Review latest values"}).click();await expect(page.getByRole("dialog")).toBeVisible();await expect(page.getByText("Latest: Another Session")).toBeVisible();await page.getByLabel("Value to keep for Firm").selectOption("mine");await page.getByRole("button",{name:"Apply choices"}).click();await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect.poll(()=>model.profile.lawFirm).toBe("My Edit");
});
test("changing email remains pending and compares the prior pending request",async({page})=>{
  const model=await setup(page,{pendingEmail:"earlier@example.test"});await open(page);await expect(page.getByText(/Confirm earlier@example.test/)).toBeVisible();await page.getByLabel("Email",{exact:true}).fill("new@example.test");await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect(page.getByText("Changes saved. Verify your new email to finish changing it.")).toBeVisible();expect(model.profile.email).toBe("morgan@example.test");expect(model.writes[0].body.expectedValues.pendingEmail).toBe("earlier@example.test");await page.reload();await expect(page.getByLabel("Email",{exact:true})).toHaveValue("morgan@example.test");await expect(page.getByText(/Confirm new@example.test/)).toBeVisible();
});
test("public preview uses the member DTO and contains no private contact or account fields",async({page})=>{
  const model=await setup(page);await open(page);await page.getByRole("link",{name:"View public profile"}).click();await expect(page.getByRole("heading",{name:"Morgan Ellis"})).toBeVisible();await expect(page.getByText("Commercial law",{exact:true})).toBeVisible();await expect(page.getByText("morgan@example.test",{exact:false})).toHaveCount(0);await expect(page.getByText("NY123",{exact:false})).toHaveCount(0);expect(model.publicCalls).toBe(1);expect((await new AxeBuilder({page}).include("[data-account-preview]").analyze()).violations).toEqual([]);await page.screenshot({path:test.info().outputPath("public-preview.png"),fullPage:true});await page.getByRole("link",{name:"Edit profile"}).click();await expect(page.getByLabel("First name")).toHaveValue("Morgan");
});
test("preferences persist, update the shell, retain legacy theme until explicitly changed",async({page})=>{
  const model=await setup(page,{preferences:{theme:"mountain-dark",fontSize:"md",hideProfile:false}});await open(page,"preferences");expect(model.writes).toHaveLength(0);await expect(page.getByLabel("Theme",{exact:true})).toHaveValue("mountain-dark");await page.getByLabel("Theme",{exact:true}).selectOption("light");await expect(page.locator("html")).not.toHaveClass(/theme-dark/);await page.getByLabel("Text size",{exact:true}).selectOption("xl");await expect.poll(()=>page.locator("html").evaluate(el=>getComputedStyle(el).fontSize)).toBe("20px");await expect(page.getByText("Saved.",{exact:true})).toHaveCount(1);await page.reload();await expect(page.getByLabel("Text size",{exact:true})).toHaveValue("xl");expect(model.writes[1].body).toEqual({fontSize:"xl",expectedValues:{fontSize:"md"},expectedOwnerId:id});
});
test("failed preference rolls back without a loop and deliberate retry applies the requested value",async({page})=>{
  const model=await setup(page);await open(page,"preferences");model.preferenceFail=true;await page.getByLabel("Theme",{exact:true}).selectOption("dark");await expect(page.getByLabel("Theme",{exact:true})).toHaveValue("light");await expect(page.getByRole("button",{name:"Try again",exact:true})).toBeVisible();expect(model.writes).toHaveLength(1);model.preferenceFail=false;await page.getByRole("button",{name:"Try again",exact:true}).click();await expect(page.locator("html")).toHaveClass(/theme-dark/);await expect(page.getByLabel("Theme",{exact:true})).toHaveValue("dark");expect(model.writes).toHaveLength(2);
});
test("ambiguous profile and preference writes reconcile without repeating successful mutations",async({page})=>{
  const model=await setup(page);await open(page);model.saveLost=true;await page.getByLabel("Firm",{exact:true}).fill("Confirmed after reconnect");await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect(page.getByText("Changes saved.",{exact:true})).toBeVisible();expect(model.writes).toHaveLength(1);
  await page.getByRole("navigation",{name:"Profile settings"}).getByRole("link",{name:"Preferences",exact:true}).click();model.preferenceLost=true;await page.getByLabel("Theme",{exact:true}).selectOption("dark");await expect(page.getByLabel("Theme",{exact:true})).toHaveValue("dark");await expect(page.locator("html")).toHaveClass(/theme-dark/);await expect(page.getByRole("button",{name:"Try again",exact:true})).toHaveCount(0);expect(model.writes).toHaveLength(2);
});
test("a pending email changed elsewhere is reviewed rather than silently replaced",async({page})=>{
  const model=await setup(page);await open(page);await page.getByLabel("Email",{exact:true}).fill("my-request@example.test");model.profile.pendingEmail="another-request@example.test";await page.getByRole("button",{name:"Save changes",exact:true}).click();await page.getByRole("button",{name:"Review latest values"}).click();await expect(page.getByText(/Latest: morgan@example.test \(pending: another-request@example.test\)/)).toBeVisible();await page.getByRole("button",{name:"Apply choices"}).click();await expect(page.getByLabel("Email",{exact:true})).toHaveValue("morgan@example.test");expect(model.profile.pendingEmail).toBe("another-request@example.test");
});
test("preference conflicts expose current value and explicitly apply the saved choice",async({page})=>{
  const model=await setup(page);await open(page,"preferences");model.profile.preferences.fontSize="sm";await page.getByLabel("Text size",{exact:true}).selectOption("xl");await expect(page.getByLabel("Text size",{exact:true})).toHaveValue("sm");await page.getByRole("button",{name:"Apply my selection"}).click();await expect(page.getByLabel("Text size",{exact:true})).toHaveValue("xl");expect(model.writes[1].body.expectedValues.fontSize).toBe("sm");
});
test("all five text sizes have distinct saved rendered results",async({page})=>{
  const model=await setup(page);await open(page,"preferences");
  for(const [value,pixels]of[["xs","14px"],["sm","15px"],["md","16px"],["lg","18px"],["xl","20px"]]){await page.getByLabel("Text size",{exact:true}).selectOption(value);await expect.poll(()=>page.locator("html").evaluate(el=>getComputedStyle(el).fontSize)).toBe(pixels);expect(model.profile.preferences.fontSize).toBe(value);}
});
test("same-owner storage refresh preserves drafts through a failed check and retry",async({page,context})=>{
  const model=await setup(page);await open(page);await page.getByLabel("Firm",{exact:true}).fill("Retained across account refresh");
  const sender=await context.newPage();
  try {
    await openStorageSender(sender);
    await expect(page.getByLabel("Firm",{exact:true})).toHaveValue("Retained across account refresh");
    model.authFail=true;
    await sender.evaluate(id=>localStorage.setItem("lpc_user",JSON.stringify({id,role:"attorney",status:"approved",firstName:"Morgan updated",preferences:{theme:"dark"}})),id);
    await expect(page.getByText(/We couldn’t verify your session/)).toBeVisible();await expect(page.locator("[data-av2-shell]")).toHaveAttribute("inert","");model.authFail=false;await page.getByRole("button",{name:"Try again",exact:true}).click();await expect(page.getByLabel("Firm",{exact:true})).toHaveValue("Retained across account refresh");await expect(page.getByText("Unsaved changes",{exact:true})).toBeVisible();
  } finally {
    await sender.close();
  }
});
test("notification preferences write a single explicit leaf and reload accurately",async({page})=>{
  const model=await setup(page);await open(page,"preferences");await page.getByLabel("Email Matter updates",{exact:true}).uncheck();await expect.poll(()=>model.profile.notificationPrefs.emailCase).toBe(false);expect(model.writes[0].body).toEqual({emailCase:false,expectedValues:{emailCase:true},expectedOwnerId:id});expect(model.profile.notificationPrefs.emailMessages).toBe(true);await page.reload();await expect(page.getByLabel("Email Matter updates",{exact:true})).not.toBeChecked();
});
test("failure after a populated load is unavailable and does not show stale private fields",async({page})=>{
  const model=await setup(page);await open(page);model.profileFail=true;await page.getByRole("navigation",{name:"Profile settings"}).getByRole("link",{name:"Profile",exact:true}).click();await expect(page.getByText(/Your account couldn’t load/)).toBeVisible();await expect(page.getByLabel("First name")).toHaveCount(0);model.profileFail=false;await page.getByRole("button",{name:"Try again",exact:true}).click();await expect(page.getByLabel("First name")).toHaveValue("Morgan");
});
test("account replacement while a write is pending clears prior content and cannot alter the replacement",async({page})=>{
  const model=await setup(page);await open(page);let resolve;model.delaySave=new Promise(r=>{resolve=r;});await page.getByLabel("Firm",{exact:true}).fill("Old account edit");await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect.poll(()=>model.writes.length).toBe(1);model.owner=other;resolve();await expect(page).toHaveURL(/login\.html|dashboard-attorney\.html/);expect(model.profile.lawFirm).toBe("Ellis Legal");await expect(page.getByText("Old account edit")).toHaveCount(0);
});
test("photo accepts crop, supports keyboard positioning, preserves original and verifies removal",async({page})=>{
  const model=await setup(page);await open(page);model.png=await page.evaluate(()=>{const c=document.createElement("canvas");c.width=600;c.height=400;const x=c.getContext("2d");x.fillStyle="#6495ED";x.fillRect(0,0,600,400);x.fillStyle="#182033";x.fillRect(300,0,300,400);return c.toDataURL("image/png").split(",")[1];});
  await page.getByLabel("Choose profile photo",{exact:true}).setInputFiles({name:"portrait.png",mimeType:"image/png",buffer:Buffer.from(model.png,"base64")});await expect(page.getByRole("dialog",{name:"Edit profile photo"})).toBeVisible();expect((await new AxeBuilder({page}).include(".av2-account-dialog").analyze()).violations).toEqual([]);await page.screenshot({path:test.info().outputPath("photo-crop.png"),fullPage:true});await page.getByLabel("Zoom",{exact:true}).fill("2");await page.getByLabel("Photo position. Use arrow keys to move.",{exact:true}).focus();await page.keyboard.press("ArrowRight");await page.getByRole("button",{name:"Save photo",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);await expect(page.getByRole("img",{name:"Your profile photo"})).toBeVisible();expect(model.writes[0].body).toContain("expectedPhotoRevision");expect(model.writes[0].body).toContain("original");
  await page.getByRole("button",{name:"Edit crop",exact:true}).click();await expect(page.getByRole("dialog",{name:"Edit profile photo"})).toBeVisible();expect(model.originalCalls).toBe(1);await page.getByRole("button",{name:"Cancel",exact:true}).click();await page.getByRole("button",{name:"Remove photo",exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:"Remove photo",exact:true}).click();await expect(page.getByRole("button",{name:"Add photo",exact:true})).toBeVisible();expect(model.writes[1].body.expectedPhotoRevision).toBe("b".repeat(64));
});
test("an unsaved photo crop survives verified same-account interruption and clears on cancel",async({page,context})=>{
  await setup(page);await open(page);const png=await page.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=600;canvas.height=400;return canvas.toDataURL("image/png").split(",")[1];});await page.getByLabel("Choose profile photo",{exact:true}).setInputFiles({name:"draft.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});await page.getByLabel("Zoom",{exact:true}).fill("2.4");const originalUrl=await page.getByRole("img",{name:"Photo crop preview"}).getAttribute("src");
  const sender=await context.newPage();
  try {
    await openStorageSender(sender);await sender.evaluate(id=>localStorage.setItem("lpc_user",JSON.stringify({id,role:"attorney",status:"approved",firstName:"Same account update"})),id);await expect(page.getByRole("img",{name:"Photo crop preview"})).not.toHaveAttribute("src",originalUrl);await expect(page.getByLabel("Zoom",{exact:true})).toHaveValue("2.4");await page.getByRole("button",{name:"Cancel",exact:true}).click();await page.getByRole("button",{name:"Refresh account",exact:true}).click();await expect(page.locator("[data-account-content]")).toHaveAttribute("aria-busy","false");await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await sender.close();
  }
});
test("a failed preference retains the intended choice through navigation until deliberate retry",async({page})=>{
  const model=await setup(page);await open(page,"preferences");model.preferenceFail=true;await page.getByLabel("Theme",{exact:true}).selectOption("dark");await expect(page.getByRole("button",{name:"Try again",exact:true})).toBeVisible();await page.getByRole("navigation",{name:"Profile settings"}).getByRole("link",{name:"Profile",exact:true}).click();await page.getByRole("navigation",{name:"Profile settings"}).getByRole("link",{name:"Preferences",exact:true}).click();await expect(page.getByText("Your earlier change is not confirmed. Try again to apply your selection.")).toBeVisible();model.preferenceFail=false;await page.getByRole("button",{name:"Try again",exact:true}).click();await expect(page.getByLabel("Theme",{exact:true})).toHaveValue("dark");expect(model.writes).toHaveLength(2);
});
test("keyboard-focused profile fields remain visible above the saved-action controls",async({page})=>{
  await setup(page);await open(page);await page.setViewportSize({width:1366,height:768});
  for(const control of await page.locator("[data-account-profile-form] input:not([hidden]), [data-account-profile-form] textarea").all()){
    await control.focus();await expect.poll(()=>control.evaluate(element=>{const r=element.getBoundingClientRect();const target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return element===target||element.contains(target);})).toBe(true);
  }
});
test("settings shortcuts focus the relevant control and time zones offer readable saved choices",async({page})=>{
  const model=await setup(page);await page.goto("/attorney-v2.html#/settings?settingsTarget=timezone");await expect(page.getByLabel("Time zone",{exact:true})).toBeFocused();await expect(page.getByLabel("Time zone",{exact:true})).toHaveValue("America/New_York");await page.getByLabel("Time zone",{exact:true}).selectOption({label:"Chicago — America"});await page.getByRole("button",{name:"Save changes",exact:true}).click();await expect(page.getByText("Changes saved.",{exact:true})).toBeVisible();expect(model.writes[0].body).toEqual({timezone:"America/Chicago",expectedValues:{timezone:"America/New_York"},expectedOwnerId:id});
  await page.evaluate(()=>{location.hash="/settings?panel=profile:firm";});await expect(page.getByLabel("Firm",{exact:true})).toBeFocused();await page.evaluate(()=>{location.hash="/settings?tab=notifications";});await expect(page.getByLabel("In-app notifications",{exact:true})).toBeFocused();
});
test("profile and preferences remain readable, contained and accessible in light dark and enlarged layouts",async({page},info)=>{
  await setup(page);await open(page);
  for(const [width,height,dark,large] of [[1366,768,false,false],[390,844,false,false],[320,844,true,true],[768,1024,true,true]]){
    await page.setViewportSize({width,height});await page.evaluate(({dark,large})=>{document.documentElement.classList.toggle("theme-dark",dark);document.documentElement.style.fontSize=large?"125%":"100%";},{dark,large});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    const violations=(await new AxeBuilder({page}).include("[data-account-content]").analyze()).violations;expect(violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`profile-${width}-${dark?"dark":"light"}.png`),fullPage:true});
    await page.locator("main").evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.screenshot({path:info.outputPath(`profile-lower-${width}-${dark?"dark":"light"}.png`),fullPage:true});await page.locator("main").evaluate(el=>{el.scrollTop=0;});
  }
  await page.getByRole("navigation",{name:"Profile settings"}).getByRole("link",{name:"Preferences",exact:true}).click();await page.setViewportSize({width:390,height:844});await page.getByLabel("Theme",{exact:true}).selectOption("dark");await page.getByLabel("Text size",{exact:true}).selectOption("xl");await expect(page.locator("html")).toHaveClass(/theme-dark/);await expect.poll(()=>page.locator("html").evaluate(el=>getComputedStyle(el).fontSize)).toBe("20px");expect((await new AxeBuilder({page}).include("[data-account-content]").analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath("preferences-mobile-dark.png"),fullPage:true});await page.locator("main").evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.screenshot({path:info.outputPath("preferences-lower-mobile-dark.png"),fullPage:true});
});

test('profile save feedback stays singular and new edits do not display a stale success', async ({page}, info) => {
  const model=await setup(page);await open(page);
  const status=page.locator('.av2-account-save [role="status"]');
  const originalSave=await page.getByRole('button',{name:'Save changes',exact:true}).boundingBox();
  await page.getByLabel('Firm',{exact:true}).fill('Reviewed firm');
  await expect(status).toHaveText('Unsaved changes');
  const editedSave=await page.getByRole('button',{name:'Save changes',exact:true}).boundingBox();
  expect(editedSave.x).toBeCloseTo(originalSave.x,0);
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(status).toHaveText('Changes saved.');
  await page.getByLabel('Firm',{exact:true}).fill('Retained next edit');
  await expect(status).toHaveText('Unsaved changes');
  await expect(page.getByText('Changes saved.',{exact:true})).toHaveCount(0);
  model.saveFail=true;
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(status).toHaveText('The save could not be confirmed. Your changes are still here.');
  await expect(page.getByText('Save not confirmed',{exact:true})).toHaveCount(0);
  expect(await page.locator('[data-account-profile-form] [role="status"]').evaluateAll(nodes=>nodes.filter(n=>n.textContent.trim()).length)).toBe(1);
  await page.locator('.av2-account-save').screenshot({path:info.outputPath('one-save-message.png')});
  model.saveFail=false;
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(status).toHaveText('Changes saved.');
  expect(model.profile.lawFirm).toBe('Retained next edit');
});

test('profile photo and preview form a bounded header above every editable section', async ({page}, info) => {
  const model=await setup(page,{profileImage:`/api/users/profile-photo/${id}?v=1`});
  model.png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#6495ed';ctx.fillRect(0,0,64,64);return canvas.toDataURL('image/png').split(',')[1];});
  await open(page);
  for(const [width,large] of [[1440,false],[768,true],[320,true]]){
    await page.setViewportSize({width,height:960});
    await page.evaluate(large=>{document.documentElement.classList.toggle('theme-dark',large);document.documentElement.style.fontSize=large?'200%':'100%';document.querySelector('main').scrollTop=0;},large);
    const photo=page.locator('.av2-account-photo');
    const first=page.getByLabel('First name',{exact:true});
    const bounds=await photo.boundingBox(),field=await first.boundingBox();
    expect(bounds.y+bounds.height).toBeLessThan(field.y);
    await expect(photo.getByRole('link',{name:'View public profile',exact:true})).toHaveCount(1);
    for(const name of ['Change photo','Edit crop','Remove photo'])await expect(photo.getByRole('button',{name,exact:true})).toBeVisible();
    const overflow=await photo.locator('button,a').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,box:n.getBoundingClientRect(),scroll:n.scrollWidth,width:n.clientWidth})).filter(n=>n.box.left < -1||n.box.right>innerWidth+1||n.scroll>n.width+1).map(n=>n.text));
    expect(overflow).toEqual([]);
    await page.screenshot({path:info.outputPath(`photo-header-${width}.png`)});
    expect((await new AxeBuilder({page}).include('.av2-account-photo').analyze()).violations).toEqual([]);
  }
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>{document.documentElement.style.fontSize='100%';});
  await page.getByRole('link',{name:'View public profile',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Morgan Ellis',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Edit profile',exact:true}).click();
  await expect(page.getByLabel('First name',{exact:true})).toHaveValue('Morgan');
  expect(model.writes).toEqual([]);
});

for(const action of ['cancel','latest','mine','already-resolved'])test(`profile ${action} returns keyboard focus to the reviewed value`, async ({page}, info) => {
  const model=await setup(page);await open(page);
  await page.setViewportSize({width:320,height:844});
  await page.evaluate(()=>{document.documentElement.classList.add('theme-dark');document.documentElement.style.fontSize='200%';});
  const firm=page.getByLabel('Firm',{exact:true});await firm.fill('My review');
  if(action==='cancel'){
    await page.getByRole('button',{name:'Cancel changes',exact:true}).focus();await page.keyboard.press('Enter');
    await expect(firm).toHaveValue('Ellis Legal');
    expect(model.writes).toEqual([]);
  }else{
    model.profile.lawFirm='Changed elsewhere';
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByRole('button',{name:'Review latest values',exact:true})).toBeVisible();
    if(action==='already-resolved')model.profile.lawFirm='Ellis Legal';
    await page.getByRole('button',{name:'Review latest values',exact:true}).click();
    if(action!=='already-resolved'){
      await page.getByLabel('Value to keep for Firm').selectOption(action);
      await page.getByRole('button',{name:'Apply choices',exact:true}).focus();await page.keyboard.press('Enter');
    }
    await expect(firm).toHaveValue(action==='latest'?'Changed elsewhere':'My review');
    expect(model.writes).toHaveLength(1);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(firm).toBeFocused();
  await expect(firm).toBeInViewport();
  expect(await firm.evaluate(n=>{const b=n.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===n;})).toBe(true);
  await page.screenshot({path:info.outputPath('reviewed-field-focus.png')});
  if(action==='mine'||action==='already-resolved'){
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.getByText('Changes saved.',{exact:true})).toBeVisible();
    expect(model.profile.lawFirm).toBe('My review');
  }
});
