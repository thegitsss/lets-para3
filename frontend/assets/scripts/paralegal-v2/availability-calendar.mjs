// Date-only values stay in the existing availability contract; no UTC conversion.
export function availabilityCalendar({ node, date, today, getRange = () => null }) {
  const initial = [getRange()?.from || date.value || today,today].sort().at(-1);
  let year = Number(initial.slice(0, 4)), month = Number(initial.slice(5, 7)) - 1;
  let disabled = false, hovered = '';
  const element = node('div', { className: 'v2-inline-calendar' });
  const previous = node('button', { type: 'button', 'aria-label': 'Previous month', text: '‹' });
  const next = node('button', { type: 'button', 'aria-label': 'Next month', text: '›' });
  const monthLabel = node('span', { 'aria-live': 'polite' });
  const months = node('div', { className: 'v2-calendar-months' });
  element.append(node('div', { className: 'v2-calendar-month' }, [previous, monthLabel, next]), months);
  const iso = value => `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  const monthName = value => value.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  function paintRange() {
    const range = getRange();
    const end = range?.to || (!range?.choosingStart && hovered > range?.from ? hovered : '');
    for (const control of months.querySelectorAll('[data-calendar-date]')) {
      const value = control.dataset.calendarDate;
      const start = Boolean(range?.from && value===range.from);
      const finish = Boolean(end && value===end);
      control.classList.toggle('is-range-start',start);
      control.classList.toggle('is-range-end',finish);
      control.classList.toggle('is-in-range',Boolean(range?.from && end && value>range.from && value<end));
      control.setAttribute('aria-pressed',String(range ? start || Boolean(range.to && value===range.to) : date.value===value));
    }
  }
  function render() {
    const first = new Date(year,month,1,12), second = new Date(year,month+1,1,12);
    monthLabel.textContent=monthName(first);
    previous.disabled=disabled || iso(first).slice(0,7)<=today.slice(0,7);next.disabled=disabled;
    months.replaceChildren();
    for (const [index, shown] of [first,second].entries()) {
      const days=node('div',{className:'v2-calendar-days',role:'group','aria-label':`${monthName(shown)} — ${getRange()?.choosingStart?'choose first unavailable day':'choose first available day'}`});
      const panel=node('section',{className:'v2-calendar-month-panel'},[
        node('p',{className:'v2-calendar-panel-title',text:monthName(shown),'aria-hidden':'true'}),
        node('div',{className:'v2-calendar-weekdays','aria-hidden':'true'},['M','T','W','T','F','S','S'].map(text=>node('span',{text}))),days]);
      panel.dataset.monthIndex=String(index);
      for(let gap=0;gap<(shown.getDay()+6)%7;gap++)days.append(node('span',{'aria-hidden':'true'}));
      for(let day=1;day<=new Date(shown.getFullYear(),shown.getMonth()+1,0,12).getDate();day++) {
        const full=new Date(shown.getFullYear(),shown.getMonth(),day,12), value=iso(full);
        const control=node('button',{type:'button',text:String(day),'data-calendar-date':value,'aria-label':full.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}),disabled:disabled||value<today});
        if(value===today)control.setAttribute('aria-current','date');
        control.addEventListener('click',()=>{hovered='';date.value=value;date.dispatchEvent(new Event('change',{bubbles:true}));render();months.querySelector(`[data-calendar-date="${value}"]`)?.focus({preventScroll:true});});
        control.addEventListener('pointerenter',()=>{if(!disabled){hovered=value;paintRange();}});
        control.addEventListener('focus',()=>{if(!disabled){hovered=value;paintRange();}});
        days.append(control);
      }
      months.append(panel);
    }
    paintRange();
  }
  function move(delta){const target=new Date(year,month+delta,1,12);year=target.getFullYear();month=target.getMonth();hovered='';render();}
  previous.addEventListener('click',()=>move(-1));next.addEventListener('click',()=>move(1));
  months.addEventListener('pointerleave',()=>{hovered='';paintRange();});
  months.addEventListener('keydown',event=>{
    const current=event.target.closest('[data-calendar-date]'),delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
    if(!current||!delta)return;event.preventDefault();
    const target=new Date(`${current.dataset.calendarDate}T12:00:00`);target.setDate(target.getDate()+delta);const value=iso(target);if(value<today)return;
    const existing=months.querySelector(`[data-calendar-date="${value}"]`);
    if(!existing || !existing.getClientRects().length){year=target.getFullYear();month=target.getMonth();render();}
    months.querySelector(`[data-calendar-date="${value}"]`)?.focus({preventScroll:true});
  });
  render();
  return {element,render,showDate(value){if(/^\d{4}-\d{2}-\d{2}$/.test(value||'')){value=value<today?today:value;year=Number(value.slice(0,4));month=Number(value.slice(5,7))-1;}hovered='';render();},setDisabled(value){disabled=value;render();}};
}
