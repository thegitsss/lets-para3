import { node, link } from './dom.mjs';
export function accountNavigation(active) {
  return node('nav',{className:'av2-account-nav','aria-label':'Profile settings'},[['Profile','profile'],['Security','security'],['Preferences','preferences']].map(([title,tab])=>{const item=link(title,`#/settings${tab==='profile'?'':`?tab=${tab}`}`);if(tab===active || tab==='security' && ['blocked','closure'].includes(active))item.setAttribute('aria-current','page');return item;}));
}
