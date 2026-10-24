import {node,link} from './dom.mjs';
import {applicationStatus,applicationWarning,applicationProfileHref} from './application-model.mjs';
import {createApplicationResume} from './application-resume.mjs';
import {createApplicationDecisions} from './application-decisions.mjs';
import {createContextualBlock} from './contextual-block.mjs';
import {createHiring} from './hiring.mjs';
import {createHiringReturn} from './pending-hire.mjs';
import {createPreEngagement} from './pre-engagement.mjs';
import {timeLabel} from './workspace-model.mjs';
import {invitationStatus} from './invitation-model.mjs';

export function createApplicantReview(item,caseId,selected,context) {
  const {signal,viewState,matterStatus,archived} = context;
  const profile = item.profileSnapshot;
  const qualifications = [profile?.yearsExperience !== null && profile?.yearsExperience !== undefined ? `${profile.yearsExperience} years of experience` : '',profile?.location,profile?.specialties.slice(0,2).join(', ')].filter(Boolean).join(' · ');
  const summary = node('summary',{},[node('div',{className:'av2-applicant-identity'},[node('strong',{text:item.name}),node('span',{className:'av2-muted',text:qualifications || 'Recorded qualifications unavailable'}),node('span',{className:'av2-applicant-review-label',text:'Review application'})]),node('span',{className:'av2-applicant-state',text:`${applicationStatus(item.status)}${item.starred ? ' · Starred' : ''}`}),node('span',{className:'av2-muted',text:item.appliedAt ? `Applied ${timeLabel(item.appliedAt)}` : 'Application date unavailable'})]);
  const root = node('details',{className:'matter-application av2-applicant-review','data-application':item.applicantId},[summary]);
  const body = node('div',{className:'matter-application-body'}); root.append(body);
  let initialized = false;
  const disclosure = (label,contents,key) => {
    const detail = node('details',{className:'av2-secondary-disclosure',...(key ? {'data-applicant-section':key} : {})},[node('summary',{text:label}),node('div',{},contents)]);
    if (key) {detail.open = viewState.sections.get(item.applicantId)?.has(key) || false;detail.addEventListener('toggle',()=>{const values=viewState.sections.get(item.applicantId) || new Set();if(detail.open)values.add(key);else values.delete(key);viewState.sections.set(item.applicantId,values);});}
    return detail;
  };
  function initialize() {
    if (initialized || signal.aborted) return; initialized = true;
    if (archived || ['completed','closed','cancelled','canceled','expired'].includes(matterStatus)) body.append(node('p',{className:'av2-muted',text:'Retained application history. Hiring depends on the current Matter’s permissions.'}));
    if (item.assigned) body.append(node('p',{text:'Assigned paralegal for this Matter'}));
    if (item.status === 'accepted') body.append(node('p',{className:'av2-muted',text:'Application acceptance does not confirm hiring or funding.'}));
    for (const key of item.warnings) body.append(node('p',{className:'av2-notice',text:applicationWarning(key)}));
    body.append(node('h3',{text:'Cover letter'}),node('p',{className:'matter-application-letter',text:item.coverLetter || 'No cover letter recorded.'}));
    const currentProfile = applicationProfileHref(item,caseId,false,context.returnTo(item.applicantId));
    const documents = node('div',{className:'av2-actions'},currentProfile ? [link('View current profile and documents',currentProfile)] : [node('p',{className:'av2-muted',text:item.blocked ? 'Interaction with this paralegal is blocked.' : 'Current profile unavailable.'})]);
    if (item.resumeRecorded) documents.append(createApplicationResume(caseId,item,context));
    else documents.append(node('p',{className:'av2-muted',text:'No résumé recorded.'}));
    if (item.linkedInReference) documents.append(node('a',{href:item.linkedInReference,target:'_blank',rel:'noopener noreferrer',referrerpolicy:'no-referrer',text:'Open LinkedIn reference from application (new tab)'}));
    body.append(documents);
    if(item.linkedInReference)body.append(node('p',{className:'av2-muted',text:'LinkedIn profile content may have changed since the application was submitted.'}));
    else if(item.linkedInRecorded)body.append(node('p',{className:'av2-muted',text:'A LinkedIn reference was recorded, but its address could not be verified.'}));
    const recordedProfile = [];
    if (profile?.bio) recordedProfile.push(node('p',{text:profile.bio}));
    if (profile) recordedProfile.push(node('dl',{className:'av2-matter-facts'},[['Location',profile.location],['Availability',profile.availability],['Experience',profile.yearsExperience === null ? '' : `${profile.yearsExperience} years`],['Practice areas',profile.specialties.join(', ')],['Languages',profile.languages.join(', ')]].filter(([,value])=>value).map(([label,value])=>node('div',{},[node('dt',{text:label}),node('dd',{text:value})]))));
    body.append(disclosure('Profile recorded with the application',recordedProfile.length ? recordedProfile : [node('p',{text:'No profile snapshot recorded.'})],'profile'));
    const decisions = createApplicationDecisions(caseId,item,{...context,compact:true,autoReview:true}); body.append(decisions);
    const process = node('details',{className:'av2-secondary-disclosure av2-applicant-process','data-applicant-section':'hiring'},[node('summary',{text:'Requirements and hiring'})]);
    let processMounted = false;
    function mountProcess() {
      if (processMounted || signal.aborted) return; processMounted = true;
      const host = node('div'), requirements = node('div'); requirements.hidden = true;
      const showRequirements = () => {requirements.hidden=false;if(!requirements.children.length)requirements.append(createPreEngagement(caseId,item,{...context,autoReview:true,onContinue:()=>{requirements.hidden=true;host.hidden=false;void hiring.refresh();}}));host.hidden=true;requirements.querySelector('h3')?.setAttribute('tabindex','-1');requirements.querySelector('h3')?.focus({preventScroll:true});};
      const hiring = createHiring(caseId,item,{...context,autoReview:true,onRequirements:showRequirements});
      host.append(hiring,createHiringReturn({api:context.api,signal,ownerId:context.ownerId,privateState:context.privateState,caseId,paralegalId:item.applicantId,name:item.name})); process.append(host,requirements);
    }
    process.open=viewState.sections.get(item.applicantId)?.has('hiring') || false;
    process.addEventListener('toggle',()=>{const values=viewState.sections.get(item.applicantId) || new Set();if(process.open){values.add('hiring');mountProcess();}else values.delete('hiring');viewState.sections.set(item.applicantId,values);});
    body.append(process); if(process.open)mountProcess();
    const history = [node('ol',{},item.history.map(entry=>node('li',{text:`${entry.from === 'unknown' ? '' : `${applicationStatus(entry.from)} → `}${applicationStatus(entry.to)} · ${timeLabel(entry.at)}`})))];
    if (!item.history.length) history.push(node('p',{text:'No status changes are recorded.'}));
    if (item.withdrawnAt) history.push(node('p',{text:`Withdrawn ${timeLabel(item.withdrawnAt)}`}));
    if (item.invitations.length) history.push(node('p',{text:`${item.invitations.length} invitation record${item.invitations.length === 1 ? '' : 's'} for this Matter.`}),node('ul',{},item.invitations.map(invite=>node('li',{text:`${invitationStatus(invite.status)} · ${invite.respondedAt ? `Responded ${timeLabel(invite.respondedAt)}` : invite.invitedAt ? `Invited ${timeLabel(invite.invitedAt)}` : 'Date unavailable'}`}))),node('p',{className:'av2-muted',text:'An accepted invitation does not hire the paralegal or fund this Matter.'}),link('Review invitation history',context.invitationHref));
    body.append(disclosure('Recorded status history',history,'history'));
    if (item.blocked || !item.assigned && ['submitted','viewed','shortlisted'].includes(item.status)) body.append(disclosure('Interaction options',[createContextualBlock(caseId,{id:item.applicantId,name:item.name,mode:'application',blocked:item.blocked,canBlock:!item.blocked && !item.assigned},{...context,onRecorded:()=>context.onSaved('',null)})],'interaction'));
  }
  root.open=selected || viewState.expanded.has(item.applicantId);
  root.addEventListener('toggle',()=>{summary.querySelector('.av2-applicant-review-label').textContent=root.open ? 'Close review' : 'Review application';if(root.open){viewState.expanded.add(item.applicantId);initialize();}else viewState.expanded.delete(item.applicantId);});
  if(root.open){summary.querySelector('.av2-applicant-review-label').textContent='Close review';initialize();} return root;
}
