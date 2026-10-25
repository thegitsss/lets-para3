// Keep the named link/button as the keyboard target and preserve secondary
// controls. Only a plain click on the rest of a record opens that same target.
export function openRecordSurfaces(root,{rowSelector,primarySelector}){
 root.addEventListener('click',event=>{
  if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||!(event.target instanceof Element))return;
  if(event.target.closest('a,button,input,textarea,select,label,summary,details,[role="button"],[contenteditable="true"]'))return;
  if(String(window.getSelection()||'').trim())return;
  const row=event.target.closest(rowSelector);if(!row||!root.contains(row))return;
  const primary=row.querySelector(primarySelector);if(primary&&!primary.disabled){event.preventDefault();primary.click();}
 });
}
