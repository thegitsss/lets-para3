const axios = require("axios");

function normalizeOrganizationUrn(connection = {}) {
  const organizationUrn = String(connection.organizationUrn || "").trim();
  if (organizationUrn) return organizationUrn;
  const organizationId = String(connection.organizationId || "").trim();
  if (!organizationId) throw new Error("LinkedIn organization identifier is missing.");
  return `urn:li:organization:${organizationId}`;
}

function buildPublishText(packet = {}) {
  const body = String(packet.channelDraft?.body || "").trim();
  const closingCta = String(packet.channelDraft?.closingCta || "").trim();
  if (!body && !closingCta) return "";
  if (!closingCta) return body;
  if (!body) return closingCta;
  if (body.includes(closingCta)) return body;
  return `${body}\n\n${closingCta}`.trim();
}

function buildLinkedInPostPayload({ connection = {}, packet = {} } = {}) {
  const commentary = buildPublishText(packet);
  return {
    author: normalizeOrganizationUrn(connection),
    commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
}

async function publishLinkedInCompanyPost({ connection = {}, packet = {} } = {}) {
  const accessToken = String(connection.accessToken || "").trim();
  if (!accessToken) {
    const error = new Error("LinkedIn access token is missing.");
    error.statusCode = 401;
    throw error;
  }

  const payload = buildLinkedInPostPayload({ connection, packet });
  const apiVersion = String(connection.apiVersion || "202503").trim() || "202503";
  const response = await axios.post("https://api.linkedin.com/rest/posts", payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Linkedin-Version": apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(
      response.data?.message || response.data?.error_description || response.statusText || "LinkedIn publish failed."
    );
    error.statusCode = response.status;
    error.response = response;
    throw error;
  }

  const providerResourceId = String(response.headers?.["x-restli-id"] || response.data?.id || "").trim();
  const providerResourceUrn = String(response.data?.id || providerResourceId || "").trim();
  const permalink = response.data?.permalink || response.data?.url || "";

  return {
    providerResourceId,
    providerResourceUrn,
    permalink: String(permalink || "").trim(),
    publishedAt: new Date(),
    requestPayload: payload,
    responseSnapshot: {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "x-restli-id": response.headers?.["x-restli-id"] || "",
      },
      data: response.data || {},
    },
  };
}

module.exports = {
  buildLinkedInPostPayload,
  buildPublishText,
  normalizeOrganizationUrn,
  publishLinkedInCompanyPost,
};
