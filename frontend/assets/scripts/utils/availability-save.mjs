const changed = () => Object.assign(new Error('Your signed-in account changed. Reload before updating availability.'), { code: 'ACCOUNT_CHANGED' });
const uncertain = () => Object.assign(new Error('Availability could not be confirmed. Refresh Home before trying again.'), { code: 'AVAILABILITY_UNCONFIRMED' });

export function availabilitySnapshot(profile) {
  const details = profile?.availabilityDetails;
  if (typeof profile?.availability !== 'string' || !profile.availability.trim() || !['available', 'unavailable'].includes(details?.status)) throw uncertain();
  return JSON.parse(JSON.stringify({ availability: profile.availability, availabilityDetails: details }));
}

export async function saveAvailability(api, { ownerId, profile, status, nextAvailable, unavailableFrom, isCurrent = () => true }) {
  if (!/^[a-f0-9]{24}$/i.test(ownerId || '')) throw changed();
  const current = () => { if (!isCurrent()) throw new DOMException('The availability view changed.', 'AbortError'); };
  current();
  const expected = availabilitySnapshot(profile);
  const verify = async () => {
    current();
    const session = await api.get('/api/auth/me');
    const user = session?.user;
    current();
    if (String(user?.id || user?._id || '') !== ownerId || user?.role !== 'paralegal' || user?.status !== 'approved') throw changed();
  };
  await verify();
  let receipt;
  try {
    receipt = await api.post('/api/paralegals/update-availability', {
      expectedOwnerId: ownerId, expectedValues: { availability: expected }, status, nextAvailable: nextAvailable || null, ...(unavailableFrom?{unavailableFrom}:{}),
    });
  } catch (error) {
    if (!error.code && error.payload?.code) error.code = error.payload.code;
    throw error;
  }
  await verify();
  if (receipt?.ownerId !== ownerId) throw uncertain();
  const saved = availabilitySnapshot(receipt), details = saved.availabilityDetails;
  if (!details.updatedAt || !Number.isFinite(Date.parse(details.updatedAt))) throw uncertain();
  if (details.nextAvailable != null) {
    const date = String(details.nextAvailable).slice(0, 10), parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || details.status !== 'unavailable') throw uncertain();
  }
  if(details.scheduled){
    const from=String(details.scheduled.from || '').slice(0,10),end=String(details.scheduled.nextAvailable || '').slice(0,10);
    const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
    if(!valid(from)||!valid(end)||from>=end || status==='available' || from!==unavailableFrom || end!==nextAvailable)throw uncertain();
  } else if(status==='unavailable'&&details.status==='available'&&unavailableFrom&&unavailableFrom>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))throw uncertain();
  return saved;
}
