const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

function audioType(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_AUDIO_BYTES) return null;
  const type = String(mime || '').split(';')[0].toLowerCase();
  if (type === 'audio/webm' && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return {type, extension:'webm'};
  if (['audio/mp4', 'video/mp4'].includes(type) && buffer.toString('ascii', 4, 8) === 'ftyp') return {type:'audio/mp4', extension:'mp4'};
  return null;
}

async function transcribeMatterNotes(file, {client = require('../ai/config').getOpenAIClient(), signal} = {}) {
  const format = audioType(file?.buffer, file?.mimetype);
  if (!format) throw Object.assign(new Error('Invalid recording'), {publicStatus:415});
  if (!client) throw Object.assign(new Error('Transcription unavailable'), {publicStatus:503});
  const {toFile} = require('openai');
  const result = await client.audio.transcriptions.create({
    model:'gpt-transcribe',
    file:await toFile(file.buffer, `matter-notes.${format.extension}`, {type:format.type}),
  }, {signal, timeout:30000, maxRetries:0});
  const text = typeof result?.text === 'string' ? result.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  if (!text) throw Object.assign(new Error('No speech detected'), {publicStatus:422, code:'DICTATION_EMPTY'});
  if (text.length > 4000) throw Object.assign(new Error('Recording too long'), {publicStatus:422, code:'DICTATION_TOO_LONG'});
  return text;
}

module.exports = {MAX_AUDIO_BYTES, audioType, transcribeMatterNotes};

async function createMatterDictationSession(sdp, {client = require('../ai/config').getOpenAIClient(), signal} = {}) {
  if (typeof sdp !== 'string' || sdp.length > 65536 || !sdp.startsWith('v=0') || !sdp.includes('m=audio ') || sdp.includes('m=video ') || sdp.includes('\0')) throw Object.assign(new Error('Invalid audio offer'), {publicStatus:400});
  if (!client) throw Object.assign(new Error('Transcription unavailable'), {publicStatus:503});
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify({type:'transcription',audio:{input:{transcription:{model:'gpt-live-transcribe',delay:'minimal'},turn_detection:null}}}));
  const response = await client.post('/realtime/calls', {body:form,headers:{'Content-Type':null},signal,timeout:20000,maxRetries:0}).asResponse();
  const answer = await response.text();
  if (!answer.startsWith('v=0') || answer.length > 65536) throw Object.assign(new Error('Invalid audio answer'), {publicStatus:503});
  const callId = response.headers.get('location')?.match(/\/realtime\/calls\/([a-zA-Z0-9_-]+)$/)?.[1];
  if (callId && client.realtime?.calls?.hangup) {
    const cutoff = setTimeout(() => { void client.realtime.calls.hangup(callId,{timeout:5000,maxRetries:0}).catch(()=>{}); },125000);
    cutoff.unref();
  }
  return {sdp:answer};
}
module.exports.createMatterDictationSession = createMatterDictationSession;
