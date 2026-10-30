
    function getTurnstileToken(formEl) {
      const input = formEl?.querySelector('input[name="cf-turnstile-response"]');
      return input?.value?.trim() || "";
    }

    function getBrowserTimezone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      } catch {
        return "";
      }
    }

    const btnA = document.getElementById('btnA');
    const btnP = document.getElementById('btnP');
    const googleSignupButton = document.getElementById('googleSignupButton');
    const form = document.getElementById('signupForm');
    const signupConfirmation = document.getElementById('signupConfirmation');
    const signupConfirmationTitle = document.getElementById('signupConfirmationTitle');
    const signupConfirmationEyebrow = document.getElementById('signupConfirmationEyebrow');
    const signupConfirmationEmail = document.getElementById('signupConfirmationEmail');
    const msg = document.getElementById('msg');
    const submitBtn = document.getElementById('submitBtn');
    const roleFieldWrap = document.getElementById('roleFieldWrap');
    const togglePw = document.getElementById('togglePw');
    const pw = document.getElementById('password');
    const passwordGuidance = document.getElementById('passwordGuidance');
    const capsLockNote = document.getElementById('capsLockNote');
    const stepOnePanel = document.getElementById('stepOnePanel');
    const stepTwoPanel = document.getElementById('stepTwoPanel');
    const nextStepBtn = document.getElementById('nextStepBtn');
    const signupHeading = document.getElementById('signupHeading');
    const stepOneOptions = document.getElementById('stepOneOptions');
    const paralegalExperienceWrap = document.getElementById('paralegalExperienceWrap');

    const experienceInput = document.getElementById('paralegalExperience');
    let lastExperienceValue = experienceInput.value;
    const experienceEditFits = text => /^\d{0,2}$/.test(text);
    experienceInput.addEventListener('beforeinput', event => {
      if (!event.inputType?.startsWith('insert') || event.data == null) return;
      const start = experienceInput.selectionStart ?? experienceInput.value.length;
      const end = experienceInput.selectionEnd ?? start;
      const next = experienceInput.value.slice(0, start) + event.data + experienceInput.value.slice(end);
      if (!experienceEditFits(next)) event.preventDefault();
    });
    experienceInput.addEventListener('input', () => {
      if (experienceEditFits(experienceInput.value)) lastExperienceValue = experienceInput.value;
      else {
        experienceInput.value = lastExperienceValue;
        experienceInput.setSelectionRange(lastExperienceValue.length, lastExperienceValue.length);
      }
    });
    const insertExperienceText = (event, text) => {
      event.preventDefault();
      if (!/^\d{1,2}$/.test(text || '')) return;
      const start = experienceInput.selectionStart ?? experienceInput.value.length;
      const end = experienceInput.selectionEnd ?? start;
      if (!experienceEditFits(experienceInput.value.slice(0, start) + text + experienceInput.value.slice(end))) return;
      experienceInput.setRangeText(text, start, end, 'end');
      experienceInput.dispatchEvent(new Event('input', { bubbles: true }));
    };
    experienceInput.addEventListener('paste', event => insertExperienceText(event, event.clipboardData?.getData('text/plain')));
    experienceInput.addEventListener('drop', event => insertExperienceText(event, event.dataTransfer?.getData('text/plain')));
    const attorneyPricingText = document.getElementById('attorneyPricingText');
    const fieldErrors = new Map();
    const rolePanels = new Map();
    const emailEl = document.getElementById('email');
    const fullNameEl = document.getElementById('fullName');
    const stateWrap = document.getElementById('signupStateWrap');
    const stateSelect = document.getElementById('signupState');
    try { emailEl.value = sessionStorage.getItem('lastEmail') || ''; } catch { /* Optional convenience only. */ }

    const getNameParts = () => {
      const parts = (fullNameEl?.value || '').trim().split(/\s+/).filter(Boolean);
      return {
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' '),
      };
    };

    const syncPasswordGuidance = () => {
      if (!pw || !passwordGuidance) return;
      const shouldShow = pw.value.length > 0;
      passwordGuidance.classList.toggle('is-visible', shouldShow);
      passwordGuidance.setAttribute('aria-hidden', String(!shouldShow));
    };

    // Keep the whole focused control above the persistent footer, including WebKit's caret-only scrolling.
    const signupFieldScroll = document.querySelector('.signup-form-scroll');
    function revealSignupControl(target = document.activeElement) {
      const stage = document.querySelector('.signup-stage');
      const mobile = stage && getComputedStyle(stage).overflowY === 'auto';
      const recoverClippedControl = mobile && innerWidth > innerHeight && document.body.classList.contains('signup-application-step');
      if (!signupFieldScroll?.contains(target) && !(recoverClippedControl && stage.contains(target))) return;
      const anchor = target.matches('input[type="file"]') ? target.labels?.[0] : target;
      if (!anchor?.getClientRects().length) return;
      if (getComputedStyle(signupFieldScroll).overflowY === 'visible') {
        if (recoverClippedControl) {
          // Focus can scroll an overflow-hidden card before the outer scroller.
          // Reveal the control inside each clipped ancestor first.
          for (let parent = anchor.parentElement; parent && parent !== stage; parent = parent.parentElement) {
            if (!['hidden', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue;
            const area = parent.getBoundingClientRect(), field = anchor.getBoundingClientRect();
            if (field.top < area.top + 6) parent.scrollTop += field.top - area.top - 6;
            else if (field.bottom > area.bottom - 6) parent.scrollTop += field.bottom - area.bottom + 6;
          }
        }
        const area = mobile ? stage.getBoundingClientRect() : { top: 0, bottom: innerHeight };
        const field = anchor.getBoundingClientRect();
        const delta = field.top < area.top + 16 ? field.top - area.top - 16
          : field.bottom > area.bottom - 16 ? field.bottom - area.bottom + 16 : 0;
        if (delta) { if (mobile) stage.scrollTop += delta; else window.scrollBy(0, delta); }
        return;
      }
      const area = signupFieldScroll.getBoundingClientRect();
      const field = anchor.getBoundingClientRect();
      const inset = 6;
      if (field.top < area.top + inset) signupFieldScroll.scrollTop += field.top - area.top - inset;
      else if (field.bottom > area.bottom - inset) signupFieldScroll.scrollTop += field.bottom - area.bottom + inset;
    }
    const signupStage = document.querySelector('.signup-stage');
    let signupPointerFocus = false;
    signupStage?.addEventListener('pointerdown', () => {
      signupPointerFocus = innerWidth > innerHeight && document.body.classList.contains('signup-application-step')
        && getComputedStyle(signupStage).overflowY === 'auto';
    });
    document.addEventListener('pointerup', () => {
      if (!signupPointerFocus) return;
      signupPointerFocus = false;
      // Let the click finish before moving a small control under the pointer.
      requestAnimationFrame(() => revealSignupControl());
    });
    document.addEventListener('pointercancel', () => { signupPointerFocus = false; });
    signupStage?.addEventListener('focusin', (event) => {
      if (signupPointerFocus) return;
      revealSignupControl(event.target);
      requestAnimationFrame(() => revealSignupControl(event.target));
    });
    if (signupFieldScroll && typeof ResizeObserver === 'function') {
      new ResizeObserver(() => requestAnimationFrame(() => revealSignupControl())).observe(signupFieldScroll);
    }

    pw?.addEventListener('focus', syncPasswordGuidance);
    pw?.addEventListener('input', syncPasswordGuidance);
    const validExperience = value => /^\d{0,2}$/.test(value) && (!value || Number(value) <= 80);
    pw?.addEventListener('blur', syncPasswordGuidance);
    pw?.addEventListener('keyup', (event) => {
      if (capsLockNote) capsLockNote.hidden = !event.getModifierState('CapsLock');
    });
    syncPasswordGuidance();

    const requestedRole = new URLSearchParams(window.location.search).get('role');
    let role = requestedRole === 'paralegal' ? 'paralegal' : 'attorney';
    let googleSignupProfile = null;
    let googleSignupActive = false;
    let currentStep = 1;
    let signupFrameLocked = false;
    let signupCleanHeight = 0;
    let signupExtraFieldSpace = 0;
    let submitLocked = false;

    const updateSubmitState = () => {
      if (!submitBtn) return;
      submitBtn.disabled = submitLocked;
    };

    function setStepPanelActive(panel, active) {
      if (!panel) return;
      const controls = panel.querySelectorAll('button, input, select, textarea');

      if (!active) {
        controls.forEach((control) => {
          if (!control.disabled) {
            control.dataset.disabledByStepFlow = 'true';
            control.disabled = true;
          }
        });
        panel.classList.add('hidden-step');
        panel.hidden = true;
        panel.setAttribute('inert', '');
        panel.setAttribute('aria-hidden', 'true');
        return;
      }

      panel.hidden = false;
      panel.removeAttribute('inert');
      panel.setAttribute('aria-hidden', 'false');
      panel.classList.remove('hidden-step');
      controls.forEach((control) => {
        if (control.dataset.disabledByStepFlow === 'true') {
          control.disabled = false;
          delete control.dataset.disabledByStepFlow;
        }
      });
    }

    function updateAttorneyStepTwoPresentation(step) {
      const attorneyStepTwo = step === 2 && role === 'attorney';
      const paralegalStepTwo = step === 2 && role === 'paralegal';

      if (signupHeading) {
        signupHeading.classList.toggle('sr-only', step === 2);
        if (attorneyStepTwo) {
          signupHeading.textContent = 'Create your account, it’s free.';
        } else if (paralegalStepTwo) {
          signupHeading.textContent = 'Create your account, it’s free.';
        } else {
          signupHeading.innerHTML = 'Create your account, <em>it’s free.</em>';
        }
      }

      if (stepOneOptions) {
        stepOneOptions.hidden = step === 2;
        stepOneOptions.toggleAttribute('inert', step === 2);
        stepOneOptions.setAttribute('aria-hidden', String(step === 2));
      }
      const policySubmitLabel = document.getElementById('signupPolicySubmitLabel');
      if (policySubmitLabel) policySubmitLabel.textContent = paralegalStepTwo ? 'Submit application' : 'Submit registration';
      if (attorneyPricingText) attorneyPricingText.hidden = !attorneyStepTwo;
      nextStepBtn.hidden = step !== 1;
      document.getElementById('signupSubmitActions').hidden = step !== 2;
      document.getElementById('editSignupBasics').hidden = step !== 2;
      document.getElementById('signupPolicyReview').hidden = step !== 2;
      document.body.classList.toggle('attorney-step-two', attorneyStepTwo);
      document.body.classList.toggle('signup-step-two', paralegalStepTwo);
      document.body.classList.toggle('signup-application-step', step === 2);
      if (submitBtn && !submitLocked) {
        submitBtn.textContent = paralegalStepTwo ? 'Submit application' : 'Submit registration';
      }

    }

    function goToStep(step) {
      if (step === 1 && !document.body.classList.contains('signup-sizing-measure')) document.body.classList.remove('signup-landscape-recovery');
      if (step === 2 && currentStep === 1 && (!signupFrameLocked || !document.body.classList.contains('signup-sizing-measure'))) {
        const shell = document.querySelector('.overlay').getBoundingClientRect();
        const column = document.querySelector('.form-container').getBoundingClientRect();
        const panel = document.querySelector('.left-panel').getBoundingClientRect();
        document.body.style.setProperty('--signup-column-top', `${column.top - panel.top}px`);
        const action = nextStepBtn.getBoundingClientRect();
        const reservedActionOffset = signupFrameLocked ? parseFloat(document.body.style.getPropertyValue('--signup-action-offset')) || 0 : 0;
        document.body.style.setProperty('--signup-action-top', `${action.top - panel.top - reservedActionOffset}px`);
        document.body.style.setProperty('--signup-action-left', `${action.left - panel.left}px`);
        document.body.style.setProperty('--signup-action-width', `${action.width}px`);
        document.body.style.setProperty('--signup-action-height', `${action.height}px`);

        document.body.style.setProperty('--signup-panel-padding-bottom', getComputedStyle(document.querySelector('.left-panel')).paddingBottom);
        document.body.style.setProperty('--signup-panel-padding', getComputedStyle(document.querySelector('.left-panel')).padding);
        document.body.style.setProperty('--signup-title-size', getComputedStyle(signupHeading).fontSize);
        document.body.style.setProperty('--signup-shell-height', `${shell.height}px`);
        document.body.style.setProperty('--signup-column-height', `${column.height}px`);
      }
      currentStep = step;
      const stepTwoLayout = document.getElementById('stepTwoLayout');
      const stepTwoMedia = step === 2 ? 'all' : 'not all';
      // Apply loaded styles synchronously before measuring the frame in Safari.
      if (stepTwoLayout.sheet) stepTwoLayout.sheet.media.mediaText = stepTwoMedia;
      else stepTwoLayout.media = stepTwoMedia;
      document.getElementById('signupFooter').hidden = step !== 2;
      if (!stepOnePanel || !stepTwoPanel) return;
      if (step === 1) {
        setStepPanelActive(stepOnePanel, true);
        setStepPanelActive(stepTwoPanel, false);
        nextStepBtn.insertAdjacentElement('afterend', msg);
      } else {
        setStepPanelActive(stepOnePanel, false);
        setStepPanelActive(stepTwoPanel, true);
        document.querySelector('.signup-step-two-title').insertAdjacentElement('afterend', msg);
        updateSubmitState();
      }
      updateAttorneyStepTwoPresentation(step);
      if (step === 1) setStepPanelActive(stepTwoPanel, false);
      stateSelect.disabled = role !== 'paralegal' || step !== 2;
      document.getElementById('paralegalExperience').disabled = role !== 'paralegal' || step !== 2;
      document.getElementById('attorneyGoodStanding').disabled = role !== 'attorney' || step !== 2;
      fitSignupFooter();
    }

    function fitSignupFooter() {
      if (!signupConfirmation.hidden) return;
      if (!document.body.classList.contains('signup-sizing-measure')) {
        document.body.classList.toggle('signup-landscape-recovery', currentStep === 2 && matchMedia('(max-width: 1024px) and (max-height: 500px) and (orientation: landscape)').matches);
      }
      if (currentStep === 1) {
        if (!signupCleanHeight || document.body.classList.contains('signup-sizing-measure')) return;
        const panel = document.querySelector('.left-panel').getBoundingClientRect();
        const signIn = stepOnePanel.querySelector('.extra-links').getBoundingClientRect();
        const current = parseFloat(document.body.style.getPropertyValue('--signup-common-height')) || signupCleanHeight;
        const extra = Math.max(0, Math.ceil(signIn.bottom + 20 - panel.bottom + current - signupCleanHeight));
        document.body.style.setProperty('--signup-common-height', `${signupCleanHeight + extra}px`);
        const base = parseFloat(document.body.style.getPropertyValue('--signup-shell-height'));
        document.body.style.setProperty('--signup-common-extra', `${signupCleanHeight + extra - base}px`);
        return;
      }
      const baseHeight = parseFloat(document.body.style.getPropertyValue('--signup-action-top'))
        - parseFloat(document.body.style.getPropertyValue('--signup-column-top')) - 16;
      const needed = Math.max(0, Math.ceil(form.getBoundingClientRect().height - baseHeight));
      document.body.style.setProperty('--signup-field-space', `${needed}px`);
      let room = 0;
      const baseShell = parseFloat(document.body.style.getPropertyValue('--signup-shell-height'));
      const minimum = signupFrameLocked ? signupCleanHeight || parseFloat(document.body.style.getPropertyValue('--signup-common-height')) || 0 : 0;
      const measuring = document.body.classList.contains('signup-sizing-measure');
      const offset = parseFloat(document.body.style.getPropertyValue('--signup-action-offset')) || 0;
      signupExtraFieldSpace = measuring ? 0 : Math.max(0, needed - offset);
      document.body.style.setProperty('--signup-error-space', `${signupExtraFieldSpace}px`);
      const reserveFrame = () => {
        const height = Math.max(minimum, baseShell) + room + signupExtraFieldSpace;
        document.body.style.setProperty('--signup-footer-space', `${room}px`);
        document.body.style.setProperty('--signup-common-height', `${height}px`);
        document.body.style.setProperty('--signup-common-extra', `${height - baseShell}px`);
        document.body.classList.add('signup-shared-frame');
      };
      reserveFrame();
      if (window.matchMedia('(max-width: 768px), (max-width: 1024px) and (max-height: 500px)').matches) {
        document.body.style.setProperty('--signup-mobile-policy-height', `${document.getElementById('signupPolicyReview').getBoundingClientRect().height}px`);
        return;
      }
      for (let i = 0; i < 2; i++) {
        const back = document.getElementById('editSignupBasics').getBoundingClientRect();
        const notice = document.getElementById('signupPolicyReview').getBoundingClientRect();
        const missing = back.bottom + 4 - notice.top;
        if (missing <= .1) break;
        room += Math.ceil(missing);
        reserveFrame();
      }
    }
    if (typeof ResizeObserver === 'function') {
      let signupFitFrame;
      const signupSizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(signupFitFrame);
        signupFitFrame = requestAnimationFrame(fitSignupFooter);
      });
      signupSizeObserver.observe(document.getElementById('signupPolicyReview'));
      signupSizeObserver.observe(form);
    }

    function focusSignupField(control) {
      const target = control?.id === 'resumeUpload' ? control.closest('.signup-resume-cell')?.querySelector('.resume-empty:not([hidden]) [data-browse], .resume-result:not([hidden]) [data-replace]')
        : control?.id === 'certUpload' ? control.parentElement.querySelector('[data-cert-choose]') : control;
      target?.focus({ preventScroll: true });
      revealSignupControl(target);
    }
    function prepareSignupFrame(resetFrame = false) {
      if (submitLocked || !signupConfirmation.hidden) return;
      const step = currentStep, focused = document.activeElement;
      const selectedRole = role;
      const top = signupFieldScroll.scrollTop, x = scrollX, y = scrollY;
      const stage = document.querySelector('.signup-stage'), stageTop = stage.scrollTop;
      const reservedHeight = resetFrame === true ? 0 : parseFloat(document.body.style.getPropertyValue('--signup-common-height')) || 0;
      document.body.classList.add('signup-sizing-measure');
      let commonHeight = reservedHeight, commonFieldSpace = 0;
      signupCleanHeight = 0;
      document.body.style.setProperty('--signup-error-space', '0px');
      document.body.style.setProperty('--signup-action-offset', '0px');
      // Reserve the larger role before either form is shown, retaining its DOM
      // nodes so measuring cannot discard field drafts or selected documents.
      for (const frameRole of ['attorney', 'paralegal', selectedRole]) {
        if (role !== frameRole) setRole(frameRole, { preserveErrors: true });
        signupFrameLocked = false;
        document.body.classList.remove('signup-shared-frame');
        goToStep(1);
        goToStep(2);
        commonHeight = Math.max(commonHeight, parseFloat(document.body.style.getPropertyValue('--signup-common-height')));
        commonFieldSpace = Math.max(commonFieldSpace, parseFloat(document.body.style.getPropertyValue('--signup-field-space')) || 0);
      }
      signupFrameLocked = true;
      if (commonHeight > parseFloat(document.body.style.getPropertyValue('--signup-common-height'))) {
        document.body.style.setProperty('--signup-common-height', `${commonHeight}px`);
        fitSignupFooter();
      }
      document.body.style.setProperty('--signup-action-offset', `${commonFieldSpace}px`);
      // Fit both footer texts against the same primary-action position.
      for (const frameRole of ['attorney', 'paralegal', selectedRole]) {
        if (role !== frameRole) setRole(frameRole, { preserveErrors: true });
        goToStep(2);
      }
      // Include the first-step sign-in row, which sits below the shared action.
      goToStep(1);
      const panelBottom = document.querySelector('.left-panel').getBoundingClientRect().bottom;
      const signInBottom = stepOnePanel.querySelector('.extra-links').getBoundingClientRect().bottom;
      commonHeight = Math.max(commonHeight, parseFloat(document.body.style.getPropertyValue('--signup-common-height')) || 0);
      signupCleanHeight = commonHeight + Math.max(0, Math.ceil(signInBottom + 20 - panelBottom));
      document.body.style.setProperty('--signup-common-height', `${signupCleanHeight}px`);
      const shellBase = parseFloat(document.body.style.getPropertyValue('--signup-shell-height'));
      document.body.style.setProperty('--signup-common-extra', `${signupCleanHeight - shellBase}px`);
      if (step === 2) goToStep(2);
      document.body.classList.remove('signup-sizing-measure');
      fitSignupFooter();
      signupFieldScroll.scrollTop = top;
      focused?.focus({ preventScroll: true });
      window.scrollTo(x, y);
      stage.scrollTop = stageTop;
      revealSignupControl(focused);
    }
    let signupResizeFrame;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(signupResizeFrame);
      signupResizeFrame = requestAnimationFrame(() => prepareSignupFrame(true));
    });

    function attachResumeHandler() {
      window.LPCResumeUpload.mount(document.getElementById('resumeUpload'));
      window.LPCResumeUpload.mountCertificate(document.getElementById('certUpload'));
    }

    function clearFieldError(id) {
      const control = document.getElementById(id), error = fieldErrors.get(id);
      if (!error) return;
      if (control) {
        control.removeAttribute('aria-invalid');
        const remaining = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== error.id);
        if (remaining.length) control.setAttribute('aria-describedby', remaining.join(' '));
        else control.removeAttribute('aria-describedby');
      }
      error.remove(); fieldErrors.delete(id);
    }
    function clearFieldErrors() { [...fieldErrors.keys()].forEach(clearFieldError); }
    function showFieldError(id, message) {
      const control = document.getElementById(id);
      if (!control) return;
      let error = fieldErrors.get(id);
      if (!error) {
        error = document.createElement('p'); error.id = `${id}Error`; error.className = 'signup-field-error';
        const anchor = control.closest('.pw-wrap, .experience-input, .signup-resume-cell, .upload-wrapper') || (control.type === 'checkbox' ? control.closest('label') : control);
        anchor.insertAdjacentElement('afterend', error); fieldErrors.set(id, error);
        control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '));
      }
      error.textContent = message; control.setAttribute('aria-invalid', 'true');
    }
    function basicErrors() {
      const errors = [], { firstName, lastName } = getNameParts();
      const email = emailEl.value.trim(), password = pw.value;
      if (!firstName || !lastName) errors.push(['fullName', 'Enter your first and last name.']);
      if (!isValidEmail(email)) errors.push(['email', 'Enter a valid email address.']);
      else if (/@gmail\.co$/i.test(email)) errors.push(['email', 'Check your email address. Did you mean gmail.com instead of gmail.co?']);
      else if (isTypoEmailDomain(email)) errors.push(['email', 'Check your email address. Did you mean .com instead of .con?']);
      else if (!window.LPCEmailDomainPolicy.hasKnownSuffix(email)) errors.push(['email', 'Enter a valid email address.']);
      const passwordDecision = window.LPCSignupPasswordPolicy.validateNewPassword(password, { user: { email, firstName, lastName } });
      if (!passwordDecision.ok) errors.push(['password', passwordDecision.error]);
      return errors;
    }
    function detailErrors() {
      const errors = [];
      const value = id => (document.getElementById(id)?.value || '').trim();
      if (role === 'attorney') {
        if (!isValidBarNumber(value('bar'), value('barState'))) errors.push(['bar', 'Please enter your state bar number.']);
        if (!value('barState')) errors.push(['barState', 'Please select your bar state.']);
        if (!document.getElementById('attorneyGoodStanding').checked) errors.push(['attorneyGoodStanding', 'Please confirm that you are licensed and in good standing.']);
        if (!isValidLinkedInUrl(value('attorneyLinkedIn'))) errors.push(['attorneyLinkedIn', 'Enter a LinkedIn profile URL, including https://, or leave this optional field blank.']);
      } else {
        if (!stateSelect.value) errors.push(['signupState', 'Please select your state.']);
        if (!validExperience(value('paralegalExperience'))) errors.push(['paralegalExperience', 'Enter a whole number from 0 to 80, or leave experience blank.']);
        const resume = document.getElementById('resumeUpload')?.files?.[0];
        if (!resume) errors.push(['resumeUpload', 'Please upload your résumé as a PDF.']);
        if (!isValidLinkedInUrl(value('paralegalLinkedIn'))) errors.push(['paralegalLinkedIn', 'Enter a LinkedIn profile URL, including https://, or leave this optional field blank.']);
        for (const id of ['resumeUpload', 'certUpload']) {
          const file = document.getElementById(id)?.files?.[0];
          if (file && ((file.type && file.type !== 'application/pdf') || !/\.pdf$/i.test(file.name))) errors.push([id, 'Please choose a PDF file.']);
          else if (file && file.size > 10 * 1024 * 1024) errors.push([id, 'Please choose a PDF no larger than 10 MB.']);
        }
      }
      if (!window.LPCSignupPolicy?.read()) errors.push(['signupPolicyReload', 'Please reload the Terms and Privacy Policy before submitting.']);
      return errors;
    }
    function presentErrors(errors) {
      clearFieldErrors();
      if (!errors.length) { say(''); return true; }
      if (currentStep === 2 && innerWidth > innerHeight && innerWidth <= 1024 && innerHeight <= 500) document.body.classList.add('signup-landscape-recovery');
      if (errors.some(([id]) => ['fullName', 'email', 'password'].includes(id))) goToStep(1);
      errors.forEach(([id, message]) => showFieldError(id, message));
      say('Please check the highlighted fields.', 'err');
      fitSignupFooter();
      const first = document.getElementById(errors[0][0]);
      if (first?.disabled) document.getElementById('signupPolicyReload')?.focus();
      else focusSignupField(first);
      return false;
    }
    function validateStepOne() { syncPasswordGuidance(); return presentErrors(basicErrors()); }
    document.addEventListener('lpc:signup-policy-ready', () => {
      prepareSignupFrame(true);
      if (!fieldErrors.has('signupPolicyReload')) return;
      clearFieldError('signupPolicyReload');
      if (!fieldErrors.size) say('');
    });
    for (const type of ['input', 'change']) form.addEventListener(type, event => {
      const id = event.target.id;
      if (!fieldErrors.has(id)) return;
      const errors = currentStep === 1 ? basicErrors() : detailErrors();
      const current = errors.find(([field]) => field === id);
      if (current) showFieldError(...current); else clearFieldError(id);
      if (!fieldErrors.size) say('');
      fitSignupFooter();
    });

    function setRole(r, { preserveErrors = false } = {}) {
      if (!preserveErrors) clearFieldErrors();
      if (roleFieldWrap.childNodes.length) {
        const saved = document.createDocumentFragment();
        saved.append(...roleFieldWrap.childNodes); rolePanels.set(role, saved);
      }
      role = r;
      if (googleSignupButton) {
        googleSignupButton.href = `/api/auth/google?intent=signup&role=${encodeURIComponent(r)}`;
      }
      const showGeneralState = r !== 'attorney';
      if (stateWrap) stateWrap.style.display = showGeneralState ? '' : 'none';
      if (paralegalExperienceWrap) paralegalExperienceWrap.hidden = r !== 'paralegal';
      if (stateSelect) {
        stateSelect.required = showGeneralState;
      }
      [btnA, btnP].forEach(b => {
        const on = b.dataset.role === r;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (rolePanels.has(r)) roleFieldWrap.append(rolePanels.get(r));
      else roleFieldWrap.innerHTML = r === 'attorney'
        ? `<label for="bar"><span class="sr-only">Bar Number</span></label>
           <div class="name-row attorney-credentials-row" style="gap:12px;">
             <div class="field-col signup-bar-field">
               <input id="bar" type="text" autocomplete="off" placeholder="State Bar Number" aria-describedby="barNumberHelp" required />
               <button class="signup-bar-info" type="button" aria-label="About your state bar number" aria-expanded="false" aria-controls="barNumberHelp">i</button>
               <span id="barNumberHelp" class="signup-bar-tooltip" role="tooltip" hidden>Your bar number helps us verify that you’re a licensed attorney and remains private.</span>
             </div>
             <div class="field-col">
               <select id="barState" aria-label="Bar State" class="select-field" required>
                 <option value="">Select state</option>
                 <option value="AL">Alabama</option>
                 <option value="AK">Alaska</option>
                 <option value="AZ">Arizona</option>
                 <option value="AR">Arkansas</option>
                 <option value="CA">California</option>
                 <option value="CO">Colorado</option>
                 <option value="CT">Connecticut</option>
                 <option value="DE">Delaware</option>
                 <option value="DC">Washington, D.C.</option>
                 <option value="FL">Florida</option>
                 <option value="GA">Georgia</option>
                 <option value="HI">Hawaii</option>
                 <option value="ID">Idaho</option>
                 <option value="IL">Illinois</option>
                 <option value="IN">Indiana</option>
                 <option value="IA">Iowa</option>
                 <option value="KS">Kansas</option>
                 <option value="KY">Kentucky</option>
                 <option value="LA">Louisiana</option>
                 <option value="ME">Maine</option>
                 <option value="MD">Maryland</option>
                 <option value="MA">Massachusetts</option>
                 <option value="MI">Michigan</option>
                 <option value="MN">Minnesota</option>
                 <option value="MS">Mississippi</option>
                 <option value="MO">Missouri</option>
                 <option value="MT">Montana</option>
                 <option value="NE">Nebraska</option>
                 <option value="NV">Nevada</option>
                 <option value="NH">New Hampshire</option>
                 <option value="NJ">New Jersey</option>
                 <option value="NM">New Mexico</option>
                 <option value="NY">New York</option>
                 <option value="NC">North Carolina</option>
                 <option value="ND">North Dakota</option>
                 <option value="OH">Ohio</option>
                 <option value="OK">Oklahoma</option>
                 <option value="OR">Oregon</option>
                 <option value="PA">Pennsylvania</option>
                 <option value="RI">Rhode Island</option>
                 <option value="SC">South Carolina</option>
                 <option value="SD">South Dakota</option>
                 <option value="TN">Tennessee</option>
                 <option value="TX">Texas</option>
                 <option value="UT">Utah</option>
                 <option value="VT">Vermont</option>
                 <option value="VA">Virginia</option>
                 <option value="WA">Washington</option>
                 <option value="WV">West Virginia</option>
                 <option value="WI">Wisconsin</option>
                 <option value="WY">Wyoming</option>
               </select>
             </div>
           </div>
           <div class="attorney-details-stack">
             <div class="field-col">
               <label for="attorneyLinkedIn"><span class="sr-only">LinkedIn</span></label>
               <input id="attorneyLinkedIn" type="url" autocomplete="url" placeholder="LinkedIn (optional)" />
             </div>
             <div class="field-col">
               <label for="lawFirm"><span class="sr-only">Law Firm</span></label>
               <input id="lawFirm" type="text" autocomplete="organization" placeholder="Law Firm (optional)" />
             </div>
           </div>
           `
        : `<div class="signup-resume-cell"><div class="upload-wrapper">
             <input id="resumeUpload" type="file" accept=".pdf,application/pdf" class="upload-input" aria-label="Upload résumé, PDF required" required />
           </div>
           </div>
           <div class="upload-wrapper">
             <input id="certUpload" type="file" accept=".pdf,application/pdf" class="upload-input" aria-label="Certificate, optional" />
           </div>
           <div class="file-hint" id="certFileHint"></div>
           <label for="paralegalLinkedIn"><span class="sr-only">LinkedIn</span></label>
           <input id="paralegalLinkedIn" type="url" autocomplete="url" placeholder="LinkedIn" />`;
      const attorneyConfirmWrap = document.getElementById('attorneyConfirmWrap');
      const attorneyConfirm = document.getElementById('attorneyGoodStanding');
      if (attorneyConfirmWrap && attorneyConfirm) {
        const showConfirm = r === 'attorney';
        attorneyConfirmWrap.hidden = !showConfirm;
        attorneyConfirm.required = showConfirm;
        attorneyConfirm.disabled = !showConfirm;
      }
      if (r === 'paralegal') attachResumeHandler();
    }
    function switchSignupRole(nextRole) {
      if (submitLocked) return;
      say(''); setRole(nextRole); goToStep(1); prepareSignupFrame(); updateSubmitState();
    }
    setRole(role);
    goToStep(1);
    prepareSignupFrame();
    document.fonts.ready.then(() => prepareSignupFrame(true));
    document.getElementById('stepTwoLayout').addEventListener('load', () => prepareSignupFrame(true), { once: true });

    btnA.addEventListener('click', () => {
      if (role === 'attorney') return;
      switchSignupRole('attorney');
    });
    btnP.addEventListener('click', () => {
      if (role === 'paralegal') return;
      switchSignupRole('paralegal');
    });

    togglePw.addEventListener('click', (e) => {
      e.preventDefault();
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      togglePw.textContent = show ? 'Hide password' : 'Show password';
      togglePw.setAttribute('aria-pressed', String(show));
    });

    nextStepBtn?.addEventListener('click', () => {
      if (validateStepOne()) {
        goToStep(2);
      }
    });
    document.getElementById('editSignupBasics')?.addEventListener('click', () => {
      if (submitLocked) return;
      goToStep(1);
      document.getElementById('fullName')?.focus();
    });
    document.getElementById('resendSignupVerification')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = document.getElementById('signupVerificationStatus');
      if (button.disabled) return;
      button.disabled = true;
      status.textContent = 'Requesting a verification email…';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let cooldown = 0;
      try {
        const { secureFetch } = await import('./auth.js');
        const response = await secureFetch('/api/auth/resend-verification', { method: 'POST', body: { email: signupConfirmationEmail.dataset.address || signupConfirmationEmail.textContent.trim() }, noRedirect: true, signal: controller.signal });
        if (response.status === 429) {
          const retry = Number(response.headers.get('Retry-After'));
          cooldown = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 900) * 1000 : 60000;
          throw new Error('Please wait a little before requesting another email.');
        }
        if (!response.ok) throw new Error('We couldn’t request an email right now. Please try again.');
        cooldown = 60000;
        status.textContent = 'Request received. If this address needs verification, check your inbox and spam folder for a link. You can try again in one minute.';
      } catch (error) { status.textContent = error.name === 'AbortError' ? 'The request took too long. Please check your inbox before trying again.' : error.message; }
      finally {
        clearTimeout(timeout);
        if (cooldown) window.setTimeout(() => { button.disabled = false; status.textContent = 'You can request another verification email now.'; }, cooldown);
        else button.disabled = false;
      }
    });

    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (currentStep !== 1) return;
      e.preventDefault();
      if (validateStepOne()) {
        goToStep(2);
      }
    });

    stateSelect?.addEventListener('change', updateSubmitState);
    function say(text, cls = '') {
      if (!msg) return;
      msg.textContent = text;
      msg.className = `msg ${cls} ${text ? 'show' : ''}`.trim();
      msg.setAttribute('role', cls === 'err' ? 'alert' : 'status');
      msg.setAttribute('aria-live', cls === 'err' ? 'assertive' : 'polite');
      if (text && cls === 'err' && currentStep === 2 && !fieldErrors.size) signupFieldScroll.scrollTop = 0;
    }

    function applyGoogleSignupProfile() {
      if (!googleSignupProfile) return;
      const fullName = [googleSignupProfile.firstName, googleSignupProfile.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (fullNameEl && fullName) fullNameEl.value = fullName;
      if (emailEl) {
        emailEl.value = googleSignupProfile.email || '';
        emailEl.readOnly = true;
        emailEl.classList.add('google-verified-email');
        emailEl.setAttribute('aria-description', 'Verified by Google');
      }
    }

    async function loadGoogleSignupProfile() {
      const params = new URLSearchParams(window.location.search);
      const errorCode = params.get('google_error');
      if (errorCode) {
        const messages = {
          invalid_state: 'Google signup expired. Please try again.',
          cancelled: 'Google signup was cancelled.',
          oauth_failed: 'Google could not verify your account. Please try again.',
          identity_invalid: 'Google did not return a verified identity.',
          unavailable: 'Google signup is temporarily unavailable.',
        };
        say(messages[errorCode] || 'Google signup could not be completed.', 'err');
        return;
      }
      if (params.get('google') !== '1') return;

      try {
        const response = await fetch('/api/auth/google/signup-profile', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.profile?.email) {
          throw new Error(payload?.msg || 'Google signup session expired. Please try again.');
        }
        googleSignupProfile = payload.profile;
        googleSignupActive = true;
        applyGoogleSignupProfile();
        say('Your email is verified by Google. Complete the remaining information.', 'ok');
      } catch (err) {
        googleSignupActive = false;
        if (emailEl) {
          emailEl.readOnly = false;
          emailEl.classList.remove('google-verified-email');
          emailEl.removeAttribute('aria-description');
        }
        say(err.message || 'Google signup session expired. Please try again.', 'err');
      }
    }

    loadGoogleSignupProfile();

    function isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test((email || '').trim());
    }

    function isTypoEmailDomain(email) {
      return /@[^@\s]+\.con$/i.test((email || '').trim());
    }

    function isValidLinkedInUrl(value) {
      const raw = (value || '').trim();
      if (!raw) return true;
      try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        return (url.protocol === 'https:' || url.protocol === 'http:') && (host === 'linkedin.com' || host.endsWith('.linkedin.com'));
      } catch {
        return false;
      }
    }

    function isValidBarNumber(value, state) {
      const raw = (value || '').trim();
      if (!raw) return false;
      const normalized = raw.replace(/\s+/g, '');
      if (normalized.length < 2) return false;
      if (!/[A-Za-z0-9]/.test(normalized)) return false;
      if (state && normalized.toUpperCase() === String(state).trim().toUpperCase()) return false;
      return true;
    }

    const defaultSubmitText = submitBtn?.textContent || "Submit registration";
    let pendingTurnstileSignup = null;
    let turnstileSignupTimer = null;

    const restoreSignupButton = (label) => {
      if (!submitBtn) return;
      submitLocked = false;
      submitBtn.textContent = label || defaultSubmitText;
      updateSubmitState();
    };

    const startTurnstileSignup = (originalLabel) => {
      if (pendingTurnstileSignup) return;
      pendingTurnstileSignup = { originalLabel };
      submitLocked = true;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying…';
      }
      const failed = () => {
        if (!pendingTurnstileSignup) return;
        pendingTurnstileSignup = null;
        clearTimeout(turnstileSignupTimer);
        restoreSignupButton(originalLabel);
        say('Verification couldn’t finish. Please try again.', 'err');
      };
      turnstileSignupTimer = setTimeout(failed, 20000);
      if (!window.turnstile?.execute) { failed(); return; }
      try {
        const execute = () => {
          if (!pendingTurnstileSignup) return;
          try { window.turnstile.execute(); } catch { failed(); }
        };
        execute();
      } catch { failed(); }
    };

    window.onTurnstileSignupSuccess = (token) => {
      clearTimeout(turnstileSignupTimer);
      const pending = pendingTurnstileSignup;
      pendingTurnstileSignup = null;
      if (!pending) return;
      const finalToken = token || getTurnstileToken(form);
      if (!finalToken) {
        if (window.turnstile?.reset) {
          window.turnstile.reset();
        }
        restoreSignupButton(pending.originalLabel);
        say('Verification expired. Please try again.', 'err');
        return;
      }
      restoreSignupButton(pending.originalLabel);
      if (form.requestSubmit) {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    };

    window.onTurnstileSignupError = () => {
      clearTimeout(turnstileSignupTimer);
      const pending = pendingTurnstileSignup;
      pendingTurnstileSignup = null;
      if (window.turnstile?.reset) {
        window.turnstile.reset();
      }
      if (!pending) return;
      restoreSignupButton(pending.originalLabel);
      say('Verification failed. Please try again.', 'err');
    };

    window.onTurnstileSignupExpired = () => {
      clearTimeout(turnstileSignupTimer);
      const pending = pendingTurnstileSignup;
      pendingTurnstileSignup = null;
      if (window.turnstile?.reset) {
        window.turnstile.reset();
      }
      if (!pending) return;
      restoreSignupButton(pending.originalLabel);
      say('Verification expired. Please try again.', 'err');
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitLocked) return;
      if (!validateStepOne()) return;
      if (currentStep === 1) { goToStep(2); return; }
      if (!presentErrors(detailErrors())) return;
      const { firstName, lastName } = getNameParts();
      const email = emailEl.value.trim().toLowerCase(), password = pw.value;
      const signupState = stateSelect.value;
      const timezone = getBrowserTimezone();
      const attorneyBar = (document.getElementById('bar')?.value || '').trim();
      const attorneyLinkedIn = (document.getElementById('attorneyLinkedIn')?.value || '').trim();
      const attorneyBarState = (document.getElementById('barState')?.value || '').trim();
      const attorneyLawFirm = (document.getElementById('lawFirm')?.value || '').trim();
      const paralegalLinkedIn = (document.getElementById('paralegalLinkedIn')?.value || '').trim();
      const paralegalExperience = (document.getElementById('paralegalExperience')?.value || '').trim();
      const paralegalCertFile = document.getElementById('certUpload')?.files?.[0] || null;
      const policyDecision = window.LPCSignupPolicy.read();
      const originalText = submitBtn?.textContent || defaultSubmitText;
      const turnstileToken = getTurnstileToken(form);
      if (!turnstileToken) {
        startTurnstileSignup(originalText);
        return;
      }

      let shouldRestoreButton = true;
      const submissionController = new AbortController();
      const submissionTimeout = setTimeout(() => submissionController.abort(), 30000);
      if (submitBtn) {
        submitLocked = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        form.setAttribute('aria-busy', 'true');
        document.getElementById('resumeUpload')?.resumeUI?.busy(true);
      }

      try {
        const stateToSubmit = role === 'attorney' ? attorneyBarState : signupState;
        const formData = new FormData();
        formData.append('firstName', firstName);
        formData.append('lastName', lastName);
        formData.append('email', email);
        formData.append('password', password);
        formData.append('role', role);
        formData.append('state', stateToSubmit);
        formData.append('termsAccepted', 'true');
        formData.append('privacyAcknowledged', 'true');
        formData.append('termsHash', policyDecision.termsHash);
        formData.append('privacyHash', policyDecision.privacyHash);
        if (googleSignupActive) formData.append('googleSignupIntent', 'true');
        if (timezone) formData.append('timezone', timezone);

        if (role === 'attorney') {
          formData.append('barNumber', attorneyBar);
          formData.append('attorneyGoodStanding', 'true');
          if (attorneyBarState) formData.append('barState', attorneyBarState);
          if (attorneyLinkedIn) formData.append('linkedInURL', attorneyLinkedIn);
          if (attorneyLawFirm) formData.append('lawFirm', attorneyLawFirm);
          formData.append('attorneyPricingAccepted', 'true');
        } else {
          const resumeFile = document.getElementById('resumeUpload')?.files?.[0];
          if (resumeFile) formData.append('resume', resumeFile.type ? resumeFile : new Blob([resumeFile], { type: 'application/pdf' }), resumeFile.name || 'resume.pdf');
          if (paralegalCertFile) formData.append('certificateFile', paralegalCertFile.type ? paralegalCertFile : new Blob([paralegalCertFile], { type: 'application/pdf' }), paralegalCertFile.name || 'certificate.pdf');
          if (paralegalLinkedIn) formData.append('linkedInURL', paralegalLinkedIn);
          if (paralegalExperience) formData.append('yearsExperience', paralegalExperience);
          formData.append('paralegalQualification', ''); // Preserve the existing backend payload contract.
        }

        formData.append('turnstileToken', turnstileToken);

        const { secureFetch } = await import('./auth.js');
        const res = await secureFetch('/api/auth/register', {
          method: 'POST',
          body: formData,
          signal: submissionController.signal,
          noRedirect: true
        });

        let data = {};
        try { data = await res.json(); } catch { data = {}; }

        if (!res.ok) {
          if (data.code === 'LEGAL_DOCUMENTS_CHANGED') await window.LPCSignupPolicy?.reload();
          const errorCopy = String(data?.error || data?.msg || data?.message || '');
          const basicField = data.field || (/password/i.test(errorCopy) ? 'password' : /email|registered|already.*exists/i.test(errorCopy) ? 'email' : /first.*last.*name/i.test(errorCopy) ? 'fullName' : /bar state/i.test(errorCopy) ? 'barState' : /bar number/i.test(errorCopy) ? 'bar' : /résumé|resume/i.test(errorCopy) ? 'resumeUpload' : /certificate/i.test(errorCopy) ? 'certUpload' : '');
          if (['password', 'email', 'fullName'].includes(basicField)) {
            goToStep(1);
            focusSignupField(document.getElementById(basicField));
          }
          if (basicField) { showFieldError(basicField, errorCopy); focusSignupField(document.getElementById(basicField)); }
          if (res.status === 409) {
            throw new Error(data?.msg || 'That account is already registered.');
          }
          if (res.status === 429) throw new Error('Too many attempts. Please wait and try again.');
          throw new Error(data?.error || data?.msg || data?.message || 'Could not create account.');
        }

        // A committed registration must still show confirmation if browser storage is unavailable.
        try { sessionStorage.setItem('lastEmail', email); } catch { /* Optional convenience only. */ }
        const submittedMessage = data.emailVerified === true ? 'Submission received. Your email is verified.' : data.verificationEmailStatus !== 'sent'
          ? 'Submission received. Request another verification email from your confirmation page.' : role === 'attorney'
          ? 'Registration submitted. Check your email to verify your email address.'
          : 'Application submitted. Check your email to verify your email address.';
        try { sessionStorage.setItem('signupToast', submittedMessage); } catch { /* Confirmation remains available. */ }
        shouldRestoreButton = false;
        submitLocked = true;
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Submitted';
        }
        if (form && signupConfirmation) {
          form.hidden = true;
          document.getElementById('signupFooter').hidden = true;
          document.body.classList.add('signup-received');
          stepOneOptions.hidden = true;
          signupHeading.hidden = true;
          const verified = data.emailVerified === true;
          const sent = !verified && data.verificationEmailStatus === 'sent';
          const receiptLabel = role === 'attorney' ? 'registration' : 'application';
          signupConfirmationEyebrow.textContent = role === 'attorney' ? 'Registration received' : 'Application received';
          signupConfirmationEyebrow.hidden = sent;
          signupConfirmationTitle.textContent = verified ? 'Your email is verified.' : sent
            ? role === 'attorney' ? 'Registration received.' : 'Application submitted.'
            : 'Check your email.';
          signupConfirmationEmail.dataset.address = email;
          const lead = document.getElementById('signupConfirmationLead');
          lead.hidden = false;
          lead.textContent = verified
            ? 'Your email is verified. We’ll review your application and email you when your account is ready.'
            : sent
              ? role === 'attorney' ? 'Thank you for your interest in joining Let’s-ParaConnect.' : 'Thank you for applying to join Let’s-ParaConnect.'
              : data.verificationEmailStatus === 'unknown'
                ? `Your ${receiptLabel} is saved. If your verification email hasn’t arrived, request another link below.`
                : `Your ${receiptLabel} is saved. We couldn’t send your verification email. Please request another link below.`;
          if (sent) {
            const address = document.createElement('strong');
            address.textContent = email;
            signupConfirmationEmail.replaceChildren(
              document.createTextNode(role === 'attorney' ? 'A verification email has been sent to ' : 'We’ve sent a verification email to '),
              address,
              document.createTextNode(role === 'attorney'
                ? '. We’ll email you once our verification process is complete.'
                : '. Once your application has been reviewed, we’ll email you with a decision.')
            );
          } else {
            signupConfirmationEmail.textContent = email;
          }
          document.getElementById('resendSignupVerification').hidden = verified;
          signupConfirmation.hidden = false;
          signupConfirmationTitle.focus();
          window.scrollTo({ top: 0, behavior: 'smooth' });
          document.querySelector('.signup-stage').scrollTo({ top: 0 });
        }
      } catch (err) {
        console.error(err);
        if (window.turnstile?.reset) {
          window.turnstile.reset();
        }
        say(err.name === 'AbortError'
          ? 'We couldn’t confirm your submission yet. Please check your email or try signing in before submitting again.'
          : err.message || 'We couldn’t connect. Your entries are still here. Please try again.', 'err');
      } finally {
        clearTimeout(submissionTimeout);
        form.removeAttribute('aria-busy');
        if (shouldRestoreButton && submitBtn) {
          restoreSignupButton(originalText);
          document.getElementById('resumeUpload')?.resumeUI?.busy(false);
        }
      }
    });
