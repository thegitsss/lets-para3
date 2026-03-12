async function generateLinkedInPosts(context = {}) {
  return {
    ok: true,
    provider: "placeholder",
    generatedAt: new Date().toISOString(),
    channel: "linkedin",
    context,
    items: [],
    nextStep: "Implement LinkedIn content generation prompts and approval workflow.",
  };
}

async function generateInstagramCaptions(context = {}) {
  return {
    ok: true,
    provider: "placeholder",
    generatedAt: new Date().toISOString(),
    channel: "instagram",
    context,
    items: [],
    nextStep: "Implement Instagram caption generation with brand voice and asset references.",
  };
}

async function generateEmailCampaignDraft(context = {}) {
  return {
    ok: true,
    provider: "placeholder",
    generatedAt: new Date().toISOString(),
    channel: "email",
    context,
    draft: null,
    nextStep: "Implement lifecycle campaign drafting with audience segmentation inputs.",
  };
}

module.exports = {
  generateEmailCampaignDraft,
  generateInstagramCaptions,
  generateLinkedInPosts,
};
