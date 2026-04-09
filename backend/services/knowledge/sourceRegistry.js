const path = require("path");

const REPO_ROOT = path.join(__dirname, "../../..");

const COLLECTION_REGISTRY = Object.freeze([
  {
    key: "platform_truth",
    title: "Platform Truth",
    domain: "platform_truth",
    description: "Canonical, approved facts about what LPC is, how it works, and what it is not.",
    audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
  },
  {
    key: "founder_voice",
    title: "Founder Voice",
    domain: "founder_voice",
    description: "Governed founder-style tone, cadence, and language guardrails.",
    audienceScopes: ["marketing_safe", "public_approved", "sales_safe"],
  },
  {
    key: "admissions_policy",
    title: "Admissions & Policy",
    domain: "admissions_policy",
    description: "Approved admissions and policy language for public and internal use.",
    audienceScopes: ["internal_ops", "support_safe", "sales_safe", "marketing_safe", "public_approved"],
  },
  {
    key: "positioning",
    title: "Positioning",
    domain: "positioning",
    description: "Approved positioning and audience-fit language for LPC.",
    audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
  },
  {
    key: "distinctiveness",
    title: "Distinctiveness",
    domain: "distinctiveness",
    description: "Approved LPC distinctiveness language without competitor framing.",
    audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
  },
  {
    key: "objection_handling",
    title: "Objection Handling",
    domain: "objection_handling",
    description: "Approved, truthful responses to common objections and questions.",
    audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
  },
  {
    key: "audience_value",
    title: "Audience Value",
    domain: "audience_value",
    description: "Audience-specific value language for attorneys and paralegals.",
    audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
  },
]);

const SOURCE_REGISTRY = Object.freeze([
  {
    sourceKey: "public_concierge_prompt",
    title: "Public Concierge Prompt",
    filePath: "backend/ai/prompts.js",
    items: [
      {
        key: "platform_lpc_core_explainer",
        collectionKey: "platform_truth",
        title: "What LPC Is",
        domain: "platform_truth",
        recordType: "fact_card",
        audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["public", "platform", "overview"],
        content: {
          summary:
            "Use this as the baseline explanation of LPC: a professional platform where attorneys engage approved independent paralegals for project-based legal support.",
          statement:
            "Let's-ParaConnect is a professional platform where attorneys hire approved independent paralegals for project-based legal support.",
          supportingPoints: [
            "The explanation should stay simple and top-level in public-facing contexts.",
            "It should not drift into staffing-agency or marketplace hype language.",
          ],
        },
        citations: [
          {
            sourceKey: "public_concierge_prompt",
            label: "backend/ai/prompts.js",
            filePath: "backend/ai/prompts.js",
            locator: "PUBLIC_CONCIERGE_PROMPT",
            excerpt:
              "Let's-ParaConnect is a professional platform where attorneys hire approved independent paralegals for project-based legal support.",
          },
        ],
      },
      {
        key: "platform_approval_based_access",
        collectionKey: "admissions_policy",
        title: "Approval-Based Access",
        domain: "admissions_policy",
        recordType: "policy_card",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["approval", "admissions"],
        content: {
          summary:
            "Attorney and paralegal accounts are reviewed before approval. Use this when explaining LPC's standards and access model without implying guaranteed outcomes.",
          statement: "Both attorney and paralegal accounts are reviewed before they are approved.",
          supportingPoints: [
            "Approval should be described as intentional and quality-protective, not arbitrary.",
            "Do not promise approval outcomes or timelines in marketing copy.",
          ],
        },
        citations: [
          {
            sourceKey: "public_concierge_prompt",
            label: "backend/ai/prompts.js",
            filePath: "backend/ai/prompts.js",
            locator: "PUBLIC_CONCIERGE_PROMPT",
            excerpt: "Both attorney and paralegal accounts are reviewed before they are approved.",
          },
        ],
      },
      {
        key: "platform_minimum_case_amount",
        collectionKey: "platform_truth",
        title: "$400 Minimum Matter Threshold",
        domain: "platform_truth",
        recordType: "fact_card",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["pricing", "minimum"],
        content: {
          summary:
            "LPC requires a $400 minimum on posted matters. Treat this as a platform fact, not as a persuasive or inflated claim.",
          statement: "All matters posted on LPC require a $400 minimum.",
          supportingPoints: [
            "Use this as a fact, not as an aggressive sales lever.",
          ],
        },
        citations: [
          {
            sourceKey: "public_concierge_prompt",
            label: "backend/ai/prompts.js",
            filePath: "backend/ai/prompts.js",
            locator: "PUBLIC_CONCIERGE_PROMPT",
            excerpt: "All matters posted on LPC require a $400 minimum.",
          },
        ],
      },
    ],
  },
  {
    sourceKey: "attorney_faq",
    title: "Attorney FAQ",
    filePath: "frontend/attorney-faq.html",
    items: [
      {
        key: "positioning_attorney_fit",
        collectionKey: "positioning",
        title: "Built for Solo and Small-Firm Attorneys",
        domain: "positioning",
        recordType: "positioning_card",
        audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["attorney", "fit"],
        content: {
          summary:
            "Use this positioning card when describing who LPC is designed for: solo and small-firm attorneys seeking structured paralegal support.",
          statement:
            "Let's-ParaConnect is a software platform designed to help solo and small-firm attorneys engage experienced paralegals through structured, project-based support work.",
          supportingPoints: [
            "Use this when explaining who LPC is built for.",
            "Avoid broad enterprise or generic marketplace framing unless later approved.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_faq",
            label: "frontend/attorney-faq.html",
            filePath: "frontend/attorney-faq.html",
            locator: "For Attorneys intro",
            excerpt:
              "Let’s-ParaConnect is a software platform designed to help solo and small-firm attorneys engage experienced paralegals through structured, project-based support work.",
          },
        ],
      },
      {
        key: "distinctiveness_structured_project_work",
        collectionKey: "distinctiveness",
        title: "Structured, Project-Based Legal Support",
        domain: "distinctiveness",
        recordType: "distinctiveness_card",
        audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["workflow", "distinctiveness"],
        content: {
          summary:
            "This is core LPC distinctiveness language: support work is structured and project-based rather than loose or generic task exchange.",
          statement:
            "LPC is built around structured, project-based support work rather than loose, generic task exchange.",
          supportingPoints: [
            "Use structured and project-based as approved distinctiveness language.",
            "Do not imply LPC is a staffing agency or assignment engine.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_faq",
            label: "frontend/attorney-faq.html",
            filePath: "frontend/attorney-faq.html",
            locator: "For Attorneys intro",
            excerpt:
              "structured, project-based support work — without staffing agencies, full-time hiring commitments, or administrative friction",
          },
        ],
      },
      {
        key: "objection_platform_fee_attorney",
        collectionKey: "objection_handling",
        title: "Attorney Platform Fee",
        domain: "objection_handling",
        recordType: "objection_card",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 90,
        tags: ["fee", "attorney", "objection"],
        content: {
          summary:
            "Use this when an attorney asks how LPC charges for completed work. Keep the explanation factual, restrained, and inclusive of Stripe processing.",
          objection: "Why is there a platform fee?",
          approvedResponse:
            "Let’s-ParaConnect charges a 22% platform fee on completed, paid projects. Stripe processing fees apply as part of the Stripe payment transaction.",
          supportingPoints: [
            "Keep the fee explanation factual and restrained.",
            "Do not hide Stripe processing from the explanation.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_faq",
            label: "frontend/attorney-faq.html",
            filePath: "frontend/attorney-faq.html",
            locator: "Question 8",
            excerpt:
              "Let’s-ParaConnect charges a 22% platform fee on completed, paid projects. Stripe processing fees apply as part of the Stripe payment transaction.",
          },
        ],
      },
      {
        key: "platform_guardrail_what_lpc_is_not",
        collectionKey: "platform_truth",
        title: "What LPC Is Not",
        domain: "platform_truth",
        recordType: "claim_guardrail",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["guardrail", "platform"],
        content: {
          summary:
            "Use these guardrails to keep LPC descriptions accurate. They define what LPC should not be described as in support, sales, or public messaging.",
          statement:
            "Let’s-ParaConnect is not a law firm, does not provide legal advice, does not assign engagements, and is not an escrow service, money transmitter, or payment processor.",
          claimsToAvoid: [
            "Do not describe LPC as a law firm or as providing legal advice.",
            "Do not describe LPC as assigning work or guaranteeing matches.",
            "Do not imply LPC itself is the payment processor.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_faq",
            label: "frontend/attorney-faq.html",
            filePath: "frontend/attorney-faq.html",
            locator: "Question 6",
            excerpt:
              "Let’s-ParaConnect is not a law firm, does not provide legal advice, does not assign engagements, and is not an escrow service, money transmitter, or payment processor.",
          },
        ],
      },
      {
        key: "audience_value_attorneys",
        collectionKey: "audience_value",
        title: "Why LPC Fits Attorneys",
        domain: "audience_value",
        recordType: "value_card",
        audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["attorney", "value"],
        content: {
          audience: "attorneys",
          summary:
            "Use this value card when explaining the practical benefit to attorneys: structured access to experienced paralegal support without staffing-agency overhead or full-time hiring commitments.",
          statement:
            "LPC gives attorneys a structured way to engage experienced paralegals for project-based support work without staffing-agency overhead or full-time hiring commitments.",
          supportingPoints: [
            "Emphasize structure, standards, and audience fit.",
            "Keep the value practical rather than hype-driven.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_faq",
            label: "frontend/attorney-faq.html",
            filePath: "frontend/attorney-faq.html",
            locator: "For Attorneys intro",
            excerpt:
              "without staffing agencies, full-time hiring commitments, or administrative friction",
          },
        ],
      },
      {
        key: "objection_minimum_case_budget",
        collectionKey: "objection_handling",
        title: "Why LPC Sets a $400 Minimum",
        domain: "objection_handling",
        recordType: "objection_card",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["minimum", "objection"],
        content: {
          summary:
            "Use this response when someone asks why LPC sets a minimum matter amount. The explanation should stay anchored in platform standards and engagement quality.",
          objection: "Why is there a $400 minimum?",
          approvedResponse:
            "To maintain the standards of the platform, cases posted on Let’s-ParaConnect have a minimum of $400 and are intended to support focused, professional engagements rather than under-scoped work.",
          supportingPoints: [
            "Use this explanation when the objection is about standards and fit.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_faq",
            label: "frontend/attorney-faq.html",
            filePath: "frontend/attorney-faq.html",
            locator: "Question 7",
            excerpt:
              "cases posted on Let’s-ParaConnect have a minimum of $400 ... and supports focused, professional engagements rather than transactional or under-scoped work",
          },
        ],
      },
    ],
  },
  {
    sourceKey: "paralegal_faq",
    title: "Paralegal FAQ",
    filePath: "frontend/paralegal-faq.html",
    items: [
      {
        key: "audience_value_paralegals",
        collectionKey: "audience_value",
        title: "Why LPC Fits Paralegals",
        domain: "audience_value",
        recordType: "value_card",
        audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["paralegal", "value"],
        content: {
          audience: "paralegals",
          summary:
            "Use this value card when explaining LPC to paralegals: approved profiles can pursue project-based support work with choice, fit, and remote workflow flexibility.",
          statement:
            "Approved paralegals can connect with attorneys seeking project-based support work, choose which matters to pursue, and work remotely through LPC’s workflow.",
          supportingPoints: [
            "Use this to explain value without implying guaranteed volume.",
            "Keep the language tied to approval, fit, and choice.",
          ],
        },
        citations: [
          {
            sourceKey: "paralegal_faq",
            label: "frontend/paralegal-faq.html",
            filePath: "frontend/paralegal-faq.html",
            locator: "Questions 1 and 4",
            excerpt:
              "approved paralegal profiles can connect with attorneys seeking project-based support work ... You have full control over which matters you apply to.",
          },
        ],
      },
      {
        key: "objection_paralegal_fee",
        collectionKey: "objection_handling",
        title: "Paralegal Fee Structure",
        domain: "objection_handling",
        recordType: "objection_card",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 90,
        tags: ["paralegal", "fee", "objection"],
        content: {
          summary:
            "Use this when a paralegal asks about costs to join LPC. It clarifies that there is no upfront fee while preserving the truth about the earned-work platform fee.",
          objection: "Do paralegals pay upfront to join?",
          approvedResponse:
            "There are no subscription fees or upfront costs for paralegals. LPC charges an 18% platform fee on completed, paid work.",
          supportingPoints: [
            "Do not imply zero fees overall; explain the fee timing truthfully.",
          ],
        },
        citations: [
          {
            sourceKey: "paralegal_faq",
            label: "frontend/paralegal-faq.html",
            filePath: "frontend/paralegal-faq.html",
            locator: "Question 2",
            excerpt:
              "There are no subscription fees or upfront costs for paralegals. Let's-ParaConnect charges an 18% platform fee on completed, paid work.",
          },
        ],
      },
      {
        key: "distinctiveness_remote_project_based",
        collectionKey: "distinctiveness",
        title: "Remote, Project-Based Engagements",
        domain: "distinctiveness",
        recordType: "distinctiveness_card",
        audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["remote", "project-based", "distinctiveness"],
        content: {
          summary:
            "Use this distinctiveness card when emphasizing LPC's remote, project-based operating model and the direct decision-making between attorneys and paralegals.",
          statement:
            "All work on LPC is remote and project-based, with attorneys and paralegals deciding directly whether to work together.",
          supportingPoints: [
            "Use this as LPC distinctiveness language, not as a broad future promise.",
          ],
        },
        citations: [
          {
            sourceKey: "paralegal_faq",
            label: "frontend/paralegal-faq.html",
            filePath: "frontend/paralegal-faq.html",
            locator: "Question 1",
            excerpt:
              "Attorneys and paralegals decide directly whether to work together. All work is fully remote, flexible, and payments are facilitated through Stripe Connect.",
          },
        ],
      },
    ],
  },
  {
    sourceKey: "paralegal_admission",
    title: "Paralegal Admission Page",
    filePath: "frontend/paralegal-admission.html",
    items: [
      {
        key: "admissions_holistic_review",
        collectionKey: "admissions_policy",
        title: "Holistic Paralegal Admission Review",
        domain: "admissions_policy",
        recordType: "policy_card",
        audienceScopes: ["internal_ops", "support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["admissions", "holistic_review"],
        content: {
          summary:
            "Paralegal applications are reviewed holistically across experience, supervision, presentation, jurisdictional alignment, platform needs, and overall suitability.",
          statement:
            "Paralegal applications are reviewed through a holistic evaluation process that considers legal experience, supervision, professional presentation, jurisdictional alignment, platform needs, and overall suitability.",
          supportingPoints: [
            "Use holistic review language exactly and avoid oversimplified pass/fail criteria.",
          ],
        },
        citations: [
          {
            sourceKey: "paralegal_admission",
            label: "frontend/paralegal-admission.html",
            filePath: "frontend/paralegal-admission.html",
            locator: "Admissions review section",
            excerpt:
              "Paralegal applications are reviewed through a holistic evaluation process ... LPC considers the clarity and substance of legal experience, supervision by licensed attorneys, professional presentation, jurisdictional alignment, platform needs, and overall suitability.",
          },
        ],
      },
      {
        key: "distinctiveness_quality_bar",
        collectionKey: "distinctiveness",
        title: "Why LPC Maintains an Approval Standard",
        domain: "distinctiveness",
        recordType: "distinctiveness_card",
        audienceScopes: ["sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["quality", "distinctiveness"],
        content: {
          summary:
            "Use this distinctiveness card when explaining why LPC keeps admission standards high: to preserve quality, confidence, and reliability for attorneys on the platform.",
          statement:
            "Admission is intentionally limited in order to preserve quality, confidence, and reliability for attorneys using the platform.",
          supportingPoints: [
            "Use this as standards language, not exclusivity hype.",
          ],
        },
        citations: [
          {
            sourceKey: "paralegal_admission",
            label: "frontend/paralegal-admission.html",
            filePath: "frontend/paralegal-admission.html",
            locator: "Admissions review section",
            excerpt:
              "Admission is intentionally limited in order to preserve quality, confidence, and reliability for attorneys using the platform.",
          },
        ],
      },
      {
        key: "objection_approval_based_quality",
        collectionKey: "objection_handling",
        title: "Why LPC Is Approval-Based",
        domain: "objection_handling",
        recordType: "objection_card",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 120,
        tags: ["approval", "quality", "objection"],
        content: {
          summary:
            "Use this response when someone asks why LPC is approval-based. The answer should stay grounded in quality, confidence, and professional standards rather than exclusivity language.",
          objection: "Why is LPC approval-based?",
          approvedResponse:
            "LPC is approval-based to preserve quality, confidence, and reliability for attorneys using the platform, while maintaining a professional standard for applicants.",
          supportingPoints: [
            "Use quality and standards language, not scarcity theater.",
          ],
        },
        citations: [
          {
            sourceKey: "paralegal_admission",
            label: "frontend/paralegal-admission.html",
            filePath: "frontend/paralegal-admission.html",
            locator: "Admissions review section",
            excerpt:
              "Admission is intentionally limited in order to preserve quality, confidence, and reliability for attorneys using the platform.",
          },
        ],
      },
    ],
  },
  {
    sourceKey: "attorney_support_prompt",
    title: "Attorney Support Prompt",
    filePath: "backend/ai/prompts.js",
    items: [
      {
        key: "founder_voice_core_style",
        collectionKey: "founder_voice",
        title: "Founder Voice Standard",
        domain: "founder_voice",
        recordType: "voice_card",
        audienceScopes: ["marketing_safe", "sales_safe", "public_approved"],
        freshnessDays: 90,
        tags: ["voice", "style"],
        content: {
          summary:
            "Founder-facing copy should feel polished, calm, concise, operational, and premium. Use this as the governed tone standard for Samantha-facing messaging.",
          rules: [
            "Answer the actual point first.",
            "Prefer the shortest complete answer.",
            "Do not sound robotic, chatty, salesy, or legalistic.",
            "Do not pretend certainty or access that does not exist.",
          ],
          claimsToAvoid: [
            "Do not promise approval outcomes.",
            "Do not promise refund outcomes.",
            "Do not imply live visibility when none exists.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_support_prompt",
            label: "backend/ai/prompts.js",
            filePath: "backend/ai/prompts.js",
            locator: "ATTORNEY_SUPPORT_PROMPT",
            excerpt:
              "Polished, calm, concise, operational, and premium. Do not sound robotic, chatty, salesy, or legalistic.",
          },
        ],
      },
      {
        key: "claim_guardrail_truthful_explanations",
        collectionKey: "platform_truth",
        title: "Truthfulness Guardrails",
        domain: "platform_truth",
        recordType: "claim_guardrail",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 90,
        tags: ["guardrail", "truthfulness"],
        content: {
          summary:
            "Use these guardrails whenever messaging needs to stay tightly truthful across public, sales-safe, and support-safe contexts.",
          claimsToAvoid: [
            "Do not claim live data access unless explicit context is present.",
            "Do not invent platform rules or policy details.",
            "Do not promise approval, payout, refund, or admin outcomes.",
          ],
        },
        citations: [
          {
            sourceKey: "attorney_support_prompt",
            label: "backend/ai/prompts.js",
            filePath: "backend/ai/prompts.js",
            locator: "ATTORNEY_SUPPORT_PROMPT",
            excerpt:
              "Do not claim to see live data unless it is explicitly present in the provided context. Never promise approval outcomes, refund outcomes, or admin decisions.",
          },
        ],
      },
    ],
  },
  {
    sourceKey: "fee_explainer_copy",
    title: "Fee Explainer Copy",
    filePath: "frontend/assets/scripts/views/case-detail.js",
    items: [
      {
        key: "objection_platform_fee_supports_infrastructure",
        collectionKey: "objection_handling",
        title: "What the Platform Fee Supports",
        domain: "objection_handling",
        recordType: "objection_card",
        audienceScopes: ["support_safe", "sales_safe", "marketing_safe", "public_approved"],
        freshnessDays: 90,
        tags: ["fee", "infrastructure", "objection"],
        content: {
          summary:
            "Use this response when someone asks what the platform fee covers. Keep the answer tied to LPC's software infrastructure and platform operations, not legal services.",
          objection: "What does the platform fee support?",
          approvedResponse:
            "The platform fee supports the tools that enable attorneys and paralegals to collaborate, including secure workspace, messaging, document sharing, workflow tools, payment processing, identity verification, and platform administration.",
          supportingPoints: [
            "Keep the explanation tied to software infrastructure.",
            "Do not imply the fee is for legal services.",
          ],
        },
        citations: [
          {
            sourceKey: "fee_explainer_copy",
            label: "frontend/assets/scripts/views/case-detail.js",
            filePath: "frontend/assets/scripts/views/case-detail.js",
            locator: "fee explanation copy",
            excerpt:
              "The platform fee supports tools that enable attorneys and paralegals to collaborate, including secure workspace, messaging, document sharing, case workflow tools, payment processing, identity verification, and platform administration.",
          },
        ],
      },
    ],
  },
]);

function resolveSourcePath(filePath = "") {
  return path.join(REPO_ROOT, filePath);
}

function listRegistrySources() {
  return SOURCE_REGISTRY.map((source) => ({
    ...source,
    absolutePath: resolveSourcePath(source.filePath),
  }));
}

function findRegistrySource(sourceKey = "") {
  return listRegistrySources().find((source) => source.sourceKey === String(sourceKey || "").trim()) || null;
}

module.exports = {
  COLLECTION_REGISTRY,
  SOURCE_REGISTRY,
  findRegistrySource,
  listRegistrySources,
  resolveSourcePath,
};
