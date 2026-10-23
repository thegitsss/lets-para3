const { escape } = require('./layout');

function accountEmailFooter({ role } = {}) {
  const base=new URL(process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || 'https://www.lets-paraconnect.com');
  if(!['http:','https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid account email origin');
  const url=path=>new URL(path,base.origin).href;
  const faq=['attorney','paralegal'].includes(role)?{label:role==='attorney'?'Attorney FAQ':'Paralegal FAQ',url:url('/'+role+'-faq.html')}:null;
  const socials=[['instagram','Instagram','https://www.instagram.com/letsparaconnect/',24],['linkedin','LinkedIn','https://www.linkedin.com/company/lets-paraconnect',22],['facebook','Facebook','https://www.facebook.com/LetsParaConnect/',23]];
  const link=(href,label,style='')=>`<a href="${escape(href)}" target="_blank" rel="noopener" style="color:#466db0;text-decoration:none;${style}">${escape(label)}</a>`;
  const year=new Date().getFullYear();
  return {
    html:`<table data-lpc-account-footer="true" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eef3fb" style="width:100%;background:#eef3fb;border-top:1px solid #e0e6ee;text-align:center;"><tr><td align="center" style="padding:30px 22px;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;line-height:1.3;color:#27394d;">${link(url('/'),'Let’s-ParaConnect','color:#27394d;font-family:Georgia,serif;')}</p>
<p style="margin:7px 0 22px;font-size:13px;line-height:1.6;color:#637187;">Legal work. Clearly connected.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr><td align="center" style="border:1px solid #27394d;border-radius:4px;">${link(url('/login.html'),'Log in','display:inline-block;min-width:106px;padding:13px 26px;font-size:14px;line-height:20px;font-weight:600;color:#27394d;')}</td></tr></table>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:8px auto 0;"><tr>${faq?`<td style="padding:0 11px;">${link(faq.url,faq.label,'display:inline-block;padding:12px 0;font-size:14px;line-height:20px;')}</td>`:''}<td style="padding:0 11px;">${link(url('/contact.html'),'Contact','display:inline-block;padding:12px 0;font-size:14px;line-height:20px;')}</td></tr></table>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:6px auto 15px;"><tr>${socials.map(([name,label,href,size],index)=>`<td align="center" width="44" height="44" style="width:44px;height:44px;${index?'padding-left:14px;':''}"><a href="${href}" target="_blank" rel="noopener" aria-label="${label}" style="display:inline-block;padding:10px;color:#27394d;text-decoration:none;"><img src="${escape(url('/assets/email/social/'+name+'.png'))}" alt="${label}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px;border:0;"></a></td>`).join('')}</tr></table>
<p style="margin:0;font-size:12px;line-height:1.7;color:#637187;">16192 Coastal Hwy, Lewes, DE 19958</p>
<p style="margin:3px 0 0;font-size:12px;line-height:1.7;color:#637187;">© ${year} Let’s-ParaConnect &nbsp;&nbsp; ${link(url('/privacy.html'),'Privacy','color:#637187;font-size:12px;')}</p>
</td></tr></table>`,
    text:`Let’s-ParaConnect\n${url('/')}\nLegal work. Clearly connected.\nLog in: ${url('/login.html')}\n${faq?`${faq.label}: ${faq.url}\n`:''}Contact: ${url('/contact.html')}\n${socials.map(([,name,href])=>name+': '+href).join('\n')}\n16192 Coastal Hwy, Lewes, DE 19958\n© ${year} Let’s-ParaConnect\nPrivacy: ${url('/privacy.html')}`,
  };
}
module.exports={accountEmailFooter};
