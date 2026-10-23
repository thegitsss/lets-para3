(() => {
  let documents = null;
  let generation = 0;
  const byId = id => document.getElementById(id);
  async function reload() {
    const ticket = ++generation;
    documents = null;
    byId("signupPolicyStatus").textContent = "Loading the policy documents…";
    byId("signupPolicyReload").hidden = true;
    try {
      const response = await fetch("/api/auth/legal/current", { credentials: "include", cache: "no-store" });
      const payload = await response.json();
      if (ticket !== generation) return;
      if (!response.ok || !payload.documents?.terms?.hash || !payload.documents?.privacy?.hash) throw new Error("Policy documents could not be loaded.");
      documents = payload.documents;
      byId("signupTermsLink").href = documents.terms.url;
      byId("signupPrivacyLink").href = documents.privacy.url;
      byId("signupPolicyStatus").textContent = "";
      document.dispatchEvent(new window.CustomEvent("lpc:signup-policy-ready"));
    } catch {
      if (ticket !== generation) return;
      byId("signupPolicyStatus").textContent = "The policy documents could not be loaded. Reload them before submitting.";
      byId("signupPolicyReload").hidden = false;
    }
  }
  window.LPCSignupPolicy = Object.freeze({
    // Submission, beside the Terms/Privacy notice, records acceptance; no separate checkboxes.
    read: () => documents ? { termsHash: documents.terms.hash, privacyHash: documents.privacy.hash } : null,
    reload,
  });
  byId("signupPolicyReload").addEventListener("click", reload);
  reload();
})();
