import { node } from './dom.mjs';
import { accountPhoto } from './account-api.mjs';
const unavailablePhotos = new Set();

export function conversationAvatar(person, className = '') {
  const avatar = node('span', {className:`av2-person-avatar ${className}`, 'aria-hidden':'true'});
  const initials = node('span', {text:String(person?.name || '').trim().split(/\s+/).slice(0,2).map(part=>part[0] || '').join('').toUpperCase() || '–'});
  avatar.append(initials);
  const photo = accountPhoto(person?.photo, person?.id);
  if (photo && !unavailablePhotos.has(photo)) {
    const image = node('img', {alt:'', loading:'lazy'});
    image.addEventListener('load',()=>{initials.hidden=true;});
    image.addEventListener('error',()=>{unavailablePhotos.add(photo);image.remove();initials.hidden=false;},{once:true});
    image.src=photo;avatar.append(image);
  }
  return avatar;
}
