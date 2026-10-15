import {button} from './dom.mjs';

// Display values are buttons; native controls exist only while that value is edited.
export function canvasValue(control, {label, placeholder, format=value=>value,persistent=()=>false} = {}) {
  const display=button('',()=>open(),'av2-canvas-value');
  display.setAttribute('aria-label',`Edit ${label}`);
  control.before(display);
  let editing=false;
  function update(){
    display.textContent=control.value ? format(control.value) : placeholder;
    display.classList.toggle('is-empty',!control.value);
    display.hidden=editing||persistent();control.hidden=!(editing||persistent());
    display.disabled=control.disabled;
  }
  function open(){
    editing=true;update();control.focus({preventScroll:true});
    if(control.tagName==='TEXTAREA'){control.style.height='auto';control.style.height=Math.max(64,control.scrollHeight+2)+'px';}
  }
  function close(){editing=false;update();}
  control.addEventListener('blur',close);
  control.addEventListener('input',()=>{display.textContent=format(control.value);});
  control.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&(control.tagName!=='TEXTAREA'||event.metaKey||event.ctrlKey)){event.preventDefault();close();(persistent()?control:display).focus();}
  });
  update();return {display,open,update};
}
