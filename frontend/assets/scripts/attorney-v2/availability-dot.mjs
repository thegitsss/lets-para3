import { node } from './dom.mjs';

export function availabilityState(profile = {}, now = Date.now()) {
  const next = profile.nextAvailable || profile.availabilityDetails?.nextAvailable;
  const date = next ? new Date(next).getTime() : NaN;
  if (Number.isFinite(date)) return date <= now ? 'available' : 'unavailable';
  const raw = String(profile.availabilityDetails?.status || profile.availability || '').trim().toLowerCase();
  if (['available', 'open', 'available now', 'immediately'].includes(raw)) return 'available';
  if (['unavailable', 'not available', 'currently unavailable', 'busy'].includes(raw)) return 'unavailable';
  return null;
}

export function availabilityDot(profile) {
  const state = availabilityState(profile);
  if (!state) return [];
  if (!document.querySelector('[data-availability-dot-style]')) document.head.append(node('link', { rel: 'stylesheet', href: '/assets/styles/availability-dot.css', 'data-availability-dot-style': '' }));
  const label = state === 'available' ? 'Available' : 'Unavailable';
  return [node('span', { className: `lpc-availability-dot is-${state}`, role: 'img', tabindex: '0', 'aria-label': label }, [node('span', { className: 'lpc-availability-tooltip', 'aria-hidden': 'true', text: label })])];
}
