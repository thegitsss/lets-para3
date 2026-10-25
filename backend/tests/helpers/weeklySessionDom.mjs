// Controlled DOM for source behavior contracts; no native browser/UI acceptance.
export function installDocument() {
  const document = { activeElement: null };
  class Element {
    constructor(tag) { this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.attributes={};this.dataset={};this.listeners=new Map();this.hidden=false;this.disabled=false;this.value='';this._text='';this.classList={add:()=>{}}; }
    setAttribute(key,value) { this.attributes[key]=String(value);if(key==='value')this.value=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=String(value); }
    getAttribute(key) { return this.attributes[key]??null; }
    append(...children) { for(const child of children){child.parentElement=this;this.children.push(child);} }
    replaceChildren(...children) { for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children); }
    contains(child) { return child===this||this.children.some(item=>item.contains(child)); }
    get isConnected() { return document.body.contains(this); }
    get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
    set textContent(value) { this._text=String(value); }
    addEventListener(type,callback,options={}) { const row={callback,capture:Boolean(options.capture)};const list=this.listeners.get(type)||[];list.push(row);this.listeners.set(type,list);options.signal?.addEventListener('abort',()=>this.listeners.set(type,list.filter(x=>x!==row)),{once:true}); }
    dispatch(type) { const path=[];for(let n=this;n;n=n.parentElement)path.push(n);const event={target:this,type,preventDefault(){},button:0};for(const n of [...path].reverse())for(const row of n.listeners.get(type)||[])if(row.capture)row.callback(event);for(const n of path)for(const row of n.listeners.get(type)||[])if(!row.capture)row.callback(event); }
    focus() { document.activeElement=this;this.dispatch('focusin'); }
    matches(selector) { if(/^[a-z][a-z0-9]*$/i.test(selector))return this.tagName.toLowerCase()===selector.toLowerCase();const match=/^\[([^=\]]+)(?:=['"]?([^'"]*)['"]?)?\]$/.exec(selector);if(match)return Object.hasOwn(this.attributes,match[1])&&(match[2]===undefined||this.getAttribute(match[1])===match[2]);return false; }
    querySelector(selector) { for(const item of this.all())if(selector.split(',').some(s=>item.matches(s.trim())))return item;return null; }
    all() { return this.children.flatMap(child=>[child,...child.all()]); }
  }
  document.createElement=tag=>new Element(tag);document.body=document.createElement('body');document.documentElement=document.createElement('html');document.activeElement=document.body;globalThis.document=document;globalThis.location={hash:''};return document;
}
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
export async function until(predicate) { for(let i=0;i<100;i++){if(predicate())return;await Promise.resolve();}throw Error('Observable source action did not finish within bounded microtask contract'); }
export const blank=()=>Array(7).fill('');
export const payload=(notes=blank(),revision='initial',weekStart='2027-01-04')=>({weekStart,notes,revision,updatedAt:null});
