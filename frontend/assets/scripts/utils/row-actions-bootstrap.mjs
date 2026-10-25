import { installRowActions } from './row-actions.mjs';
function start() {
  installRowActions(document.body);
  if (!document.querySelector('link[href*="row-actions.css"]')) {
    const style=document.createElement('link');
    style.rel='stylesheet';style.href='/assets/styles/row-actions.css';
    document.head.append(style);
  }
}
if (document.body) start();
else document.addEventListener('DOMContentLoaded',start,{once:true});
