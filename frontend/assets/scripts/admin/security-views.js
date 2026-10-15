export function initAdminSecurityViews(){
  if(document.getElementById('adminSecurityView'))return;
  const root=document.getElementById('securitySection'),grid=root?.querySelector('.security-grid');
  if(!grid)return;
  const select=document.createElement('select');select.id='adminSecurityView';select.setAttribute('aria-label','Security view');
  select.innerHTML='<option value="devices">Signed-in devices</option><option value="password">Change password</option><option value="verification">Two-step verification</option><option value="passkeys">Passkeys</option>';
  grid.before(select);
  const password=document.getElementById('currentPassword').closest('.settings-block');
  const verify=root.querySelector('.security-verification-card');
  const blocks=[password,verify,document.getElementById('twoFactorSection'),document.getElementById('passkeysSection'),document.getElementById('activeSessionsSection')];
  const choices={devices:[blocks[4]],password:[password],verification:[verify,blocks[2]],passkeys:[verify,blocks[3]]};
  const show=()=>blocks.forEach(block=>{block.dataset.adminSecurityBlock='';block.hidden=!choices[select.value].includes(block);});
  select.addEventListener('change',show);show();
  const nav=document.createElement('nav');nav.id='adminSecurityNavigation';nav.setAttribute('aria-label','Admin navigation');
  for(const [key,label] of [['overview','Overview'],['user-management','People'],['matters','Matters'],['support-ops','Inbox'],['finance','Finance'],['marketing-drafts','Growth'],['ai-control-room','System']]){
    const link=document.createElement('a');link.href=`admin-dashboard.html#${key}`;link.textContent=label;nav.append(link);
  }
  document.querySelector('.sidebar .logo')?.after(nav);
}
