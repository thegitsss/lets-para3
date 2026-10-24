// Display already-authorized preview contents. This helper never fetches a file
// or changes its permissions, review state, revision, or download behavior.
export function showDocumentQuickLook(container,{name='Document',onClose=()=>{},onDownload,returnFocus=document.activeElement}={}) {
  if(!container?.isConnected)return;
  if(!document.getElementById('lpc-document-quick-look-style')) {
    const style=document.createElement('style');style.id='lpc-document-quick-look-style';style.textContent=`
      dialog.lpc-document-quick-look {box-sizing:border-box;width:min(1000px,calc(100vw - 32px));height:min(820px,calc(100dvh - 32px));max-width:none;max-height:none;margin:auto;padding:0;border:1px solid var(--v2-line,var(--av2-line,#dfe5ed));border-radius:8px;background:var(--v2-white,var(--av2-surface,#fff));color:var(--v2-ink,var(--av2-ink,#263347));font:inherit;}
      dialog.lpc-document-quick-look[open] {display:flex;flex-direction:column;}
      dialog.lpc-document-quick-look[data-preview-kind="text"] {width:min(800px,calc(100vw - 32px));height:fit-content;max-height:calc(100dvh - 32px);}
      dialog.lpc-document-quick-look[data-preview-kind="text"] > div {flex:0 1 auto;}
      .lpc-document-quick-look::backdrop {background:#10243d80;}
      .lpc-document-quick-look > header {display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 16px;border-bottom:1px solid var(--v2-line,var(--av2-line,#dfe5ed));}
      .lpc-document-quick-look h2 {margin:0;font:inherit;font-size:16px;overflow-wrap:anywhere;}
      .lpc-document-quick-look > header button {flex:none;width:44px;height:44px;border:0;background:transparent;color:inherit;font:inherit;font-size:24px;cursor:pointer;}
      .lpc-document-quick-look > header .lpc-quick-look-actions {display:flex;align-items:center;gap:8px;flex:none;}
      .lpc-document-quick-look > header .lpc-quick-look-download {width:auto;min-height:44px;padding:0 12px;border:1px solid var(--v2-line,var(--av2-line,#dfe5ed));border-radius:5px;font:inherit;font-size:14px;}
      .lpc-document-quick-look > div {min-height:0;flex:1;overflow:auto;padding:16px;}
      .lpc-document-quick-look iframe {display:block;width:100%;height:100%;min-height:200px;border:0;}
      .lpc-document-quick-look img {display:block;max-width:100%;max-height:100%;object-fit:contain;margin:auto;}
      .lpc-document-quick-look pre {white-space:pre-wrap;overflow-wrap:anywhere;}
      @media(max-width:600px){dialog.lpc-document-quick-look{width:calc(100vw - 16px);height:calc(100dvh - 16px)}.lpc-document-quick-look > div{padding:8px}}
    `;document.head.append(style);
  }
  const contents=[...container.childNodes];
  for(const e of contents)if(e.nodeType===1&&e.matches('button')&&e.textContent==='Close preview')e.remove();
  const dialog=document.createElement('dialog');dialog.className='lpc-document-quick-look';dialog.dataset.previewKind=container.querySelector('iframe')?'document':container.querySelector('img')?'image':'text';dialog.setAttribute('aria-label',`Preview: ${name}`);
  const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button'),body=document.createElement('div');title.textContent=name;close.type='button';close.textContent='×';close.setAttribute('aria-label','Close preview');header.append(title,close);
  body.append(...contents.filter(e=>e.isConnected));const actions=document.createElement('div');actions.className='lpc-quick-look-actions';if(onDownload){const download=document.createElement('button');download.type='button';download.className='lpc-quick-look-download';download.textContent='Download';download.addEventListener('click',()=>{leave();onDownload();});actions.append(download);}actions.append(close);header.append(actions);dialog.append(header,body);container.append(dialog);
  let closed=false;
  const cleanup=()=>{if(closed)return;closed=true;observer.disconnect();window.removeEventListener('hashchange',leave);onClose();dialog.remove();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});};
  const leave=()=>{dialog.close();cleanup();};
  const observer=new MutationObserver(()=>{if(!container.isConnected)leave();});observer.observe(document.body,{childList:true,subtree:true});
  window.addEventListener('hashchange',leave);dialog.addEventListener('close',cleanup,{once:true});close.addEventListener('click',leave);dialog.addEventListener('click',e=>{if(e.target===dialog)leave();});
  dialog.showModal();close.focus();
  return {close:leave};
}
