import { node, link } from './dom.mjs';
export function accountNavigation(active) {
  return node('nav',{className:'av2-account-nav','aria-label':'Profile settings'},[['Profile','profile'],['Preferences','preferences'],['Security','security'],['Blocked users','blocked'],['Account closure','closure']].map(([title,tab])=>{const item=link(title,`#/settings${tab==='profile'?'':`?tab=${tab}`}`);if(tab===active)item.setAttribute('aria-current','page');return item;}));
}
