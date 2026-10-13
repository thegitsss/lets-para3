import {node} from './dom.mjs';
export function createCanvasLayout({section,assistant,panels,stepHeading,nav,publication,recovery,saveReview}) {
  section.classList.add('av2-living-canvas');
  nav.hidden=true; saveReview.hidden=true;
  section.querySelector('.av2-view-header').hidden=true;
  const right=node('div',{className:'av2-canvas-right'},[stepHeading,assistant.refinePanel,panels.description,panels.review]);
  const columns=node('div',{className:'av2-canvas-columns'},[assistant.intro,right]);
  section.append(columns);
  const sourceHeading=assistant.intro.querySelector('h2');
  const sourceLabel=assistant.intro.querySelector('label');
  const sourceActions=assistant.build.closest('.av2-actions');
  sourceActions.replaceChildren(assistant.manual,assistant.build);

  // Recovery and the existing final confirmation stay in this surface, never a nested modal.
  const messages=node('div',{className:'av2-canvas-messages'},[recovery.root,publication.root]);
  section.append(messages);
  if(publication.footer)section.append(publication.footer);
  const review=panels.review.querySelector('.av2-draft-review');
  const confirmationPreview=node('div',{className:'av2-confirmation-preview'},[node('h2',{text:'Ready to publish'})]);
  function update(step,state){
    section.dataset.creationStep=step;
    const shaped=step!=='describe';
    const manual=shaped&&!state.values.sourceDescription?.trim()&&!state.values.appliedSourceDescription?.trim();
    if(section.dataset.manual!==String(manual)){
      const practical=section.querySelector('.av2-compose-practical');
      for(const key of manual?['practiceArea','state','experience','deadline','compAmount']:['practiceArea','experience','state','deadline','compAmount']){
        const field=practical?.querySelector('.av2-draft-field-'+key);if(field)practical.append(field);
      }
    }
    section.dataset.manual=String(manual);
    assistant.intro.hidden=manual||step==='review'||Boolean(publication.result)||state.deleted||state.restricted;
    const confirming=step==='review'&&publication.visible&&!publication.result;
    right.hidden=step==='describe'||confirming;
    if(confirming){if(review.parentNode!==confirmationPreview)confirmationPreview.append(review);if(confirmationPreview.parentNode!==messages)messages.insertBefore(confirmationPreview,publication.root);}
    else {panels.review.prepend(review);confirmationPreview.remove();}
    sourceHeading.textContent=shaped?'Describe the work.':'Start a new Matter.';
    sourceLabel.textContent=shaped?'Add or revise your notes, then update your Matter.':'Start with your notes. We’ll put them in order.';
    const permission=assistant.intro.querySelector('.av2-compose-permission');if(permission)permission.hidden=shaped;

    assistant.brief.setAttribute('aria-label',shaped?'Describe the work':'Describe the work in your own words');
    assistant.examples.hidden=true;sourceActions.hidden=shaped;
    if(!shaped)assistant.fitBrief();else assistant.brief.style.removeProperty('height');
    if(shaped && !assistant.brief.value)assistant.brief.placeholder=state.id?'':'Details entered manually.';
    assistant.updater?.update();
    saveReview.hidden=true;nav.hidden=true;section.querySelector('.av2-view-header').hidden=true;
    stepHeading.hidden=true;
    assistant.launch.hidden=true;
    const actions=panels.review.querySelector('.av2-draft-step-actions');
    actions.hidden=publication.visible;
    if(publication.footer)publication.footer.hidden=!confirming||!publication.footer.childElementCount;
    [...publication.root.querySelectorAll('button'),...(publication.footer?.querySelectorAll('button')||[])].forEach(control=>{if(control.textContent==='Confirm and publish Matter')control.className='av2-button';if(control.textContent==='Keep editing draft')control.textContent='← Back';});
    panels.review.querySelector('.av2-compose-funding-note').hidden=publication.visible;
  }
  return {update};
}
