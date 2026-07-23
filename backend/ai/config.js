const { createLogger } = require("../utils/logger");

const logger = createLogger("ai:config");

const AI_MODELS = {
  support: process.env.OPENAI_SUPPORT_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-terra",
  marketing: process.env.OPENAI_MARKETING_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-terra",
  sales: process.env.OPENAI_SALES_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-terra",
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

async function createStructuredResponse({
  model,
  instructions,
  input,
  textFormat,
  reasoningEffort = "low",
  safetyIdentifier = "",
  metadata = {},
  timeoutMs = 30000,
  maxOutputTokens = 1800,
} = {}) {
  if (!openAIClient) {
    const err = new Error("AI is not enabled");
    err.code = "AI_DISABLED";
    throw err;
  }
  if (!textFormat) {
    const err = new Error("A structured response format is required");
    err.code = "AI_SCHEMA_REQUIRED";
    throw err;
  }

  const startedAt = Date.now();
  const response = await openAIClient.responses.parse(
    {
      model: model || AI_MODELS.support,
      instructions: String(instructions || ""),
      input,
      text: { format: textFormat },
      reasoning: { effort: reasoningEffort },
      max_output_tokens: Math.max(256, Number(maxOutputTokens) || 1800),
      store: false,
      ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    },
    { timeout: Math.max(1000, Number(timeoutMs) || 30000) }
  );

  if (!response?.output_parsed) {
    const err = new Error("AI returned no schema-valid response");
    err.code = "AI_BAD_RESPONSE";
    throw err;
  }

  return {
    data: response.output_parsed,
    telemetry: {
      responseId: String(response.id || ""),
      model: String(response.model || model || AI_MODELS.support),
      latencyMs: Date.now() - startedAt,
      inputTokens: Number(response.usage?.input_tokens || 0),
      outputTokens: Number(response.usage?.output_tokens || 0),
      totalTokens: Number(response.usage?.total_tokens || 0),
    },
  };
}

module.exports = {
  AI_MODELS,
  createJsonChatCompletion,
  createStructuredResponse,
  getAiStatus,
  getOpenAIClient,
  isAiEnabled,
};
