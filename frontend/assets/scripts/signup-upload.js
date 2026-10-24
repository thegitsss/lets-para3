/* Résumé selection UI. The existing registration request owns the upload. */
window.LPCResumeUpload = {
 mount(input) {
  if (!input) return;
  if (input.resumeUI) { input.resumeUI.refresh(); return; }
  const root = input.closest('.signup-resume-cell');
  root.classList.add('lpc-resume-upload');
  root.querySelector('label').remove();
  const hint = root.querySelector('#resumeFileHint');
  hint.remove();
  root.insertAdjacentHTML('beforeend', `<div class="resume-zone" aria-label="Résumé upload">
   <span class="resume-meta">PDF required<br>Max 10 MB</span>
   <div class="resume-empty"><div class="resume-art" aria-hidden="true"><div class="resume-back"></div><div class="resume-paper"></div><div class="resume-paper second"></div><div class="resume-front"></div></div>
   <div>Drop your résumé here</div><div class="resume-sub">or <button type="button" class="resume-link" data-browse>browse files</button></div></div>
   <div class="resume-result" hidden><div class="resume-filemark" aria-hidden="true">PDF</div><div class="resume-filetext"><div class="resume-filename"></div><div class="resume-sub" data-status role="status"></div><div class="resume-actions"><button type="button" class="resume-link" data-replace>Replace</button><button type="button" class="resume-link" data-remove>Remove</button></div></div></div>
  </div><div id="resumeFileHint" class="resume-error" role="alert" hidden></div>`);
  const zone = root.querySelector('.resume-zone'), empty = root.querySelector('.resume-empty'), result = root.querySelector('.resume-result'), error = root.querySelector('.resume-error'), status = root.querySelector('[data-status]');
  input.setAttribute('aria-describedby', 'resumeFileHint');
  input.tabIndex = -1;
  let selected = input.files?.[0] || null, timer, depth = 0, busy = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const assign = file => { const transfer = new window.DataTransfer(); if (file) transfer.items.add(file); input.files = transfer.files; };
  const showError = message => { error.textContent = message; error.hidden = !message; input.setAttribute('aria-invalid', String(!!message)); };
  const render = () => {
   zone.classList.remove('settling');
   empty.hidden = !!selected; result.hidden = !selected;
   root.querySelector('.resume-filename').textContent = selected?.name || '';
   status.textContent = selected ? 'Selected · ready to submit' : '';
  };
  const choose = files => {
   if (busy || !files.length) return;
   const file = files[0];
   let problem = files.length !== 1 ? 'Choose one résumé PDF.' : !/\.pdf$/i.test(file.name) || (file.type && file.type !== 'application/pdf') ? 'Choose a PDF résumé.' : file.size > 10 * 1024 * 1024 ? 'Résumé must be 10 MB or smaller.' : !file.size ? 'This file is empty. Choose a PDF résumé.' : '';
   if (problem) { assign(selected); showError(problem); return; }
   clearTimeout(timer); selected = file; assign(file); showError('');
   zone.classList.remove('over'); depth = 0;
   // Cosmetic paper settling only; the file is selected, not uploaded.
   input.dispatchEvent(new Event('input', { bubbles: true }));
   if (reduced.matches) { render(); return; }
   const focused = root.contains(document.activeElement);
   empty.hidden = false; result.hidden = true; zone.classList.add('settling');
   timer = setTimeout(() => { if (!root.isConnected) return; render(); if (focused) root.querySelector('[data-replace]').focus({preventScroll:true}); }, 650);
  };
  root.querySelector('[data-browse]').onclick = root.querySelector('[data-replace]').onclick = () => { if (!busy) input.click(); };
  root.querySelector('[data-remove]').onclick = () => { if (busy) return; clearTimeout(timer); selected = null; assign(null); showError(''); render(); input.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector('[data-browse]').focus({preventScroll:true}); };
  input.addEventListener('change', () => choose([...input.files]));
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  zone.addEventListener('dragenter', e => { stop(e); if (!busy) { depth++; zone.classList.add('over'); } });
  zone.addEventListener('dragover', e => { stop(e); e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; });
  zone.addEventListener('dragleave', e => { stop(e); if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } });
  zone.addEventListener('drop', e => { stop(e); depth = 0; zone.classList.remove('over'); choose([...e.dataTransfer.files]); });
  reduced.addEventListener('change', () => { if (reduced.matches) { clearTimeout(timer); render(); } });
  input.resumeUI = {
   refresh() { clearTimeout(timer); render(); },
   busy(value) { busy = value; clearTimeout(timer); render(); const hidden = !!input.closest('[hidden], [inert]'); for (const control of [input, ...root.querySelectorAll('button')]) { control.disabled = value || hidden; if (!value && hidden) control.dataset.disabledByStepFlow = 'true'; } if (value) status.textContent = 'Submitting with your application…'; },
   error(message) { showError(message); }
  };
  render();
 }
};
window.LPCResumeUpload.mountCertificate = input => {
 if (!input || input.dataset.certificateMounted) return;
 input.dataset.certificateMounted = 'true';
 const wrapper = input.parentElement;
 const label = wrapper.querySelector('label');
 label.remove();
 wrapper.classList.add('lpc-certificate-upload');
 wrapper.insertAdjacentHTML('beforeend', `<div class="certificate-zone"><div class="certificate-details"><span data-cert-name>Certificate</span><small data-cert-status>(optional)</small><small class="certificate-format">PDF · Max 10 MB</small></div><div class="certificate-actions"><button type="button" data-cert-choose>Upload</button><button type="button" data-cert-remove hidden>Remove</button></div></div>`);
 const zone=wrapper.querySelector('.certificate-zone'), name=wrapper.querySelector('[data-cert-name]'), status=wrapper.querySelector('[data-cert-status]'), choose=wrapper.querySelector('[data-cert-choose]'), remove=wrapper.querySelector('[data-cert-remove]'), error=document.getElementById('certFileHint');
 error.setAttribute('role','alert'); input.setAttribute('aria-describedby','certFileHint'); input.tabIndex=-1;
 let selected=null,depth=0;
 const assign=file=>{const dt=new window.DataTransfer();if(file)dt.items.add(file);input.files=dt.files;};
 const render=()=>{name.textContent=selected?.name||'Certificate';name.title=selected?.name||'';status.textContent=selected?'Selected':'(optional)';choose.textContent=selected?'Replace':'Upload';remove.hidden=!selected;};
 const accept=files=>{if(!files.length)return;const file=files[0];const message=files.length!==1?'Choose one certificate PDF.':!/\.pdf$/i.test(file.name)||(file.type&&file.type!=='application/pdf')?'Choose a PDF certificate.':file.size>10*1024*1024?'Certificate must be 10 MB or smaller.':!file.size?'This file is empty. Choose a PDF certificate.':'';error.textContent=message;input.setAttribute('aria-invalid',String(!!message));if(message){assign(selected);return;}selected=file;assign(file);render();input.dispatchEvent(new Event('input',{bubbles:true}));};
 zone.addEventListener('click', event => { if (!event.target.closest('button') && !input.disabled) input.click(); });
 choose.onclick=()=>input.click();remove.onclick=()=>{selected=null;assign(null);error.textContent='';input.removeAttribute('aria-invalid');render();input.dispatchEvent(new Event('input',{bubbles:true}));choose.focus();};
 input.addEventListener('change',()=>accept([...input.files]));
 zone.addEventListener('dragenter',e=>{e.preventDefault();depth++;zone.classList.add('over');});zone.addEventListener('dragover',e=>e.preventDefault());zone.addEventListener('dragleave',e=>{e.preventDefault();if(--depth<=0){depth=0;zone.classList.remove('over');}});zone.addEventListener('drop',e=>{e.preventDefault();depth=0;zone.classList.remove('over');accept([...e.dataTransfer.files]);});render();
};
