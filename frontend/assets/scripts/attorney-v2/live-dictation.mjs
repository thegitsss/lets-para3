// Audio uses WebRTC; session credentials stay on the authenticated app server.
export function createLiveDictation({api,ownerId,signal,onText,onReady,onError}) {
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel('oai-events');
  const items = new Map();
  let stream, closed=false, intentional=false, finish, finishTimer, connectTimer;
  let stage='microphone';
  const diagnose=(extra={})=>window.dispatchEvent(new CustomEvent('lpc:dictation-diagnostic',{detail:{stage,connectionState:peer.connectionState,iceConnectionState:peer.iceConnectionState,...extra}}));
  const stopTracks=()=>{stream?.getTracks().forEach(track=>track.stop());stream=null;};
  function close() {
    if(closed)return;
    closed=true;clearTimeout(connectTimer);clearTimeout(finishTimer);stopTracks();
    channel.close();peer.close();finish?.();signal.removeEventListener('abort',close);
  }
  function fail(message){if(closed)return;close();onError(message);}
  signal.addEventListener('abort',close,{once:true});
  channel.addEventListener('open',()=>{if(closed)return;clearTimeout(connectTimer);onReady();});
  channel.addEventListener('message',event=>{
    if(closed)return;
    let data;try{data=JSON.parse(event.data);}catch{return;}
    if(data.type==='conversation.item.input_audio_transcription.delta') {
      items.set(data.item_id,(items.get(data.item_id)||'')+(data.delta||''));
      onText([...items.values()].join(' ').trim());
    } else if(data.type==='conversation.item.input_audio_transcription.completed') {
      items.set(data.item_id,data.transcript||'');onText([...items.values()].join(' ').trim());
      if(intentional){finish?.();close();}
    } else if(data.type==='error'||data.type==='conversation.item.input_audio_transcription.failed') {
      if(intentional&&data.error?.code==='input_audio_buffer_commit_empty'){finish?.();close();return;}
      fail('Dictation couldn’t continue. Your text is still here. Tap the microphone to retry.');
    }
  });
  channel.addEventListener('close',()=>{if(!closed&&!intentional)fail('Dictation disconnected. Your text is still here. Tap the microphone to reconnect.');});
  peer.addEventListener('connectionstatechange',()=>{if(!closed&&!intentional&&['failed','closed'].includes(peer.connectionState))fail('The dictation connection was lost. Your text is still here.');});
  async function start() {
    connectTimer=setTimeout(()=>{diagnose({reason:'connection_timeout'});fail('Dictation couldn’t connect. Your text is still here. Try again.');},25000);
    try {
      const incoming=await navigator.mediaDevices.getUserMedia({audio:true});
      if(closed||signal.aborted){incoming.getTracks().forEach(track=>track.stop());return;}
      stream=incoming;stream.getAudioTracks().forEach(track=>peer.addTrack(track,stream));
      stage='offer';const offer=await peer.createOffer();await peer.setLocalDescription(offer);
      stage='handshake';const sdp=await api.connectMatterDictation(offer.sdp,{ownerId,signal});
      if(closed||signal.aborted)return;
      stage='peer_connection';await peer.setRemoteDescription({type:'answer',sdp});
    } catch(error) {
      if(closed||signal.aborted)return;
      diagnose({reason:'start_failed',status:error.status||0,code:error.code||'',errorName:error.name||''});
      fail(error.status===429?'Too many dictation attempts. Wait a minute, then try again.':error.name==='NotAllowedError'?'Microphone access was denied. Allow access in your browser or keep typing.':error.name==='NotFoundError'?'No microphone was found. Connect one or keep typing.':error.name==='NotReadableError'?'Your microphone couldn’t open. Check that it’s connected and available, then try again.':error.code==='DICTATION_AI_DISABLED'?'Enable AI in Settings to use dictation, or keep typing.':'Dictation couldn’t connect. Your text is still here. Try again.');
    }
  }
  async function stop() {
    if(closed)return;
    intentional=true;stopTracks();
    if(channel.readyState!=='open'){close();return;}
    await new Promise(resolve=>{finish=resolve;finishTimer=setTimeout(()=>{resolve();close();},3000);channel.send(JSON.stringify({type:'input_audio_buffer.commit'}));});
    close();
  }
  return {start,stop,close};
}
