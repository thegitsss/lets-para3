const { createLogger } = require("../utils/logger");

const logger = createLogger("ai:config");

const AI_MODELS = {
  support: process.env.OPENAI_SUPPORT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  marketing: process.env.OPENAI_MARKETING_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  sales: process.env.OPENAI_SALES_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
};

let OpenAI = null;
let openAIClient = null;
let initError = null;

try {
  OpenAI = require("openai");
  OpenAI = OpenAI?.default || OpenAI;
} catch (err) {
  initError = err;
  logger.warn("OpenAI SDK unavailable; AI features will use fallback behavior.", err?.message || err);
}

if (!initError && process.env.OPENAI_API_KEY) {
  try {
    openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (err) {
    initError = err;
    logger.warn("OpenAI client initialization failed; AI features will use fallback behavior.", err?.message || err);
  }
}

if (openAIClient) {
  logger.info("OpenAI client initialized successfully.", {
    enabled: true,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
  });
} else if (process.env.OPENAI_API_KEY) {
  logger.error("OpenAI client initialization failed at startup.", initError || "Unknown OpenAI initialization error.");
} else {
  logger.warn("OpenAI client disabled at startup because OPENAI_API_KEY is missing.");
}

function isAiEnabled() {
  return Boolean(openAIClient);
}

function getOpenAIClient() {
  return openAIClient;
}

function getAiStatus() {
  return {
    enabled: isAiEnabled(),
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    initError: initError ? initError.message : null,
    models: AI_MODELS,
  };
}

function safeJsonParse(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

async function createJsonChatCompletion({ systemPrompt, userPrompt, model, temperature = 0.2, messages }) {
  if (!openAIClient) {
    const err = new Error("AI is not enabled");
    err.code = "AI_DISABLED";
    throw err;
  }

  const requestMessages =
    Array.isArray(messages) && messages.length
      ? messages
      : [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ];

  const response = await openAIClient.chat.completions.create({
    model: model || AI_MODELS.support,
    temperature,
    response_format: { type: "json_object" },
    messages: requestMessages,
  });

  const content = response?.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(content);
  if (!parsed) {
    const err = new Error("AI returned non-JSON content");
    err.code = "AI_BAD_RESPONSE";
    throw err;
  }

  return parsed;
}

module.exports = {
  AI_MODELS,
  createJsonChatCompletion,
  getAiStatus,
  getOpenAIClient,
  isAiEnabled,
};
