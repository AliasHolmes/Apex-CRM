import {
  openAIStructured,
  Type,
  runWithLlmStageLane,
} from "../services/llm.js";
import {
  verifyEvidencePassage,
  type FinalistCandidate,
} from "./finalistJudge.js";
import type { ProspectContract } from "./prospectContract.js";
import { normalizeDomainUrl } from "./siteProbe.js";
import { cleanCompanyForDomainSearch } from "./companyIntent.js";
import {
  getEnrichmentCacheEntry,
  computeRequirementsFingerprint,
  getCompanyProfile,
  upsertCompanyProfile,
  getCompanyAttributionVerdict,
  upsertCompanyAttributionVerdict,
  type StoredCompanyProfile,
} from "../db.js";

export type CompanyBusinessModel =
  | "b2b_services"
  | "consumer_services"
  | "software_product"
  | "physical_goods"
  | "retail_ecommerce"
  | "healthcare_provider"
  | "financial_services"
  | "public_education_nonprofit"
  | "other";

export type CompanyAttributionVerdict =
  | "verified_fit"
  | "unverified"
  | "disqualifying_contradiction";

export type CompanyAttributionResult = {
  companyDomain: string;
  companyName: string;
  businessModel: CompanyBusinessModel;
  industry?: string;
  primaryOffering: string;
  queryAlignment: "matches_brief" | "adjacent" | "contradicts";
  verbatimEvidenceQuote: string;
  verdict: CompanyAttributionVerdict;
  reason: string;
  quoteVerified?: boolean;
  fromStoredProfile?: boolean;
};

export const bulkCompanyAttributionSchema = {
  type: Type.OBJECT,
  properties: {
    attributions: {
      type: Type.ARRAY,
      description: "Attribution evaluations for each company",
      items: {
        type: Type.OBJECT,
        properties: {
          companyKey: {
            type: Type.STRING,
            description: "Identifier or domain of the company matching the prompt input",
          },
          businessModel: {
            type: Type.STRING,
            description: "b2b_services, consumer_services, software_product, physical_goods, retail_ecommerce, healthcare_provider, financial_services, public_education_nonprofit, or other",
          },
          industry: {
            type: Type.STRING,
            description: "The company's industry in 2-5 words (e.g. freight forwarding, hospital, dental clinic, AI automation agency)",
          },
          primaryOffering: {
            type: Type.STRING,
            description: "Core service or product offering in 1-2 concise sentences",
          },
          queryAlignment: {
            type: Type.STRING,
            description: "matches_brief, adjacent, or contradicts",
          },
          verbatimEvidenceQuote: {
            type: Type.STRING,
            description: "Exact word-for-word quote from company source text supporting the business model",
          },
          verdict: {
            type: Type.STRING,
            description: "verified_fit, unverified, or disqualifying_contradiction",
          },
          reason: {
            type: Type.STRING,
            description: "Concise 1-sentence explanation of the attribution verdict",
          },
        },
        required: [
          "companyKey",
          "businessModel",
          "queryAlignment",
          "verdict",
          "reason",
        ],
      },
    },
  },
  required: ["attributions"],
};

export const COMPANY_ATTRIBUTION_SYSTEM_PROMPT = `You are a B2B company intelligence analyst. Read scraped company evidence and decide what the company is and whether it is the kind of organization the prospect search brief asks for. Apply the same rules to every industry.

RULES:
1. BUSINESS MODEL: classify the company as one of:
   - "b2b_services": services delivered to other organizations (agencies, consultancies, law and accounting firms, logistics providers, contractors, staffing).
   - "consumer_services": services delivered to individuals (salons, gyms, tutoring, personal care).
   - "software_product": sells software, SaaS, apps or developer tools.
   - "physical_goods": manufactures or distributes physical products.
   - "retail_ecommerce": sells goods directly to buyers online or in stores.
   - "healthcare_provider": hospitals, clinics, practices and care providers.
   - "financial_services": banks, insurers, lenders, investment and payment firms.
   - "public_education_nonprofit": government bodies, schools, universities, charities.
   - "other": anything else.
   Also give the company's industry in 2-5 words.

2. ALIGNMENT with the brief's company type and industry requirements:
   - "verified_fit": the evidence shows the company is the kind of organization the brief asks for (the same industry or an obvious sub-category of it).
   - "disqualifying_contradiction": the evidence clearly shows a different kind of organization than the brief requires (for example the brief asks for hospitals and the company sells hospital software, or the brief asks for law firms and the company is a legal-tech vendor).
   - "unverified": the evidence is sparse, generic, parked, or does not say what the company does.

3. QUOTE CITATION:
   - verbatimEvidenceQuote MUST be an EXACT literal substring from the provided company source text. Do NOT paraphrase or invent quotes. If no clear quote exists, leave it empty.

4. Keep reasons concise (under 25 words total). Emit valid JSON matching the schema immediately.`;

export function extractCompanySourceText(candidate: FinalistCandidate): {
  companyName: string;
  domain: string;
  sourceText: string;
} {
  const lead = candidate.lead || {};
  const companyName = String(
    lead.currentCompany || lead.company || lead.profile?.currentCompany || "",
  ).trim();
  const rawUrl = String(
    lead.contactDetails?.website ||
      lead.profile?.contactDetails?.website ||
      lead.companyAccount?.website ||
      lead.website ||
      "",
  ).trim();
  const normalizedUrl = normalizeDomainUrl(rawUrl);
  let domain = "";
  if (normalizedUrl) {
    try {
      domain = new URL(normalizedUrl).hostname.replace(/^www\./, "").toLowerCase();
    } catch {}
  }

  // 1. Check enrichment cache if domain is known
  let sourceText = "";
  if (domain) {
    try {
      const cached = getEnrichmentCacheEntry({ normalizedUrl: domain });
      if (cached?.evidenceBlock && cached.evidenceBlock.length > 50) {
        sourceText = cached.evidenceBlock;
      }
    } catch {}
  }

  // 2. Check candidate evidence for [COMPANY SITE or [COMPANY SIGNAL snippets
  if (!sourceText && Array.isArray(candidate.evidence)) {
    const siteItems = candidate.evidence.filter((item) =>
      item &&
      typeof item.text === "string" &&
      (item.text.includes("[COMPANY SITE") ||
        item.text.includes("[COMPANY SIGNAL") ||
        item.text.includes("official website")),
    );
    if (siteItems.length > 0) {
      sourceText = siteItems.map((item) => item.text).join("\n");
    }
  }

  // 3. Fallback to general evidence snippet if it mentions the company
  //    GUARD: Exclude evidence that is clearly person-bio (LinkedIn profile,
  //    candidate summary, resume) rather than company-sourced content, and require
  //    meaningful text length (>80) and company name length (>=4) to prevent false substring collisions.
  if (!sourceText && Array.isArray(candidate.evidence)) {
    const personBioTags = ["[PROFILE", "[LINKEDIN", "[CANDIDATE", "[RESUME"];
    const matchingSnippets = candidate.evidence.filter((item) =>
      item &&
      typeof item.text === "string" &&
      item.text.length > 80 &&
      companyName &&
      companyName.length >= 4 &&
      item.text.toLowerCase().includes(companyName.toLowerCase()) &&
      !personBioTags.some((tag) => item.text.includes(tag)),
    );
    if (matchingSnippets.length > 0) {
      sourceText = matchingSnippets.map((item) => item.text).join("\n");
    }
  }

  return {
    companyName,
    domain: domain || sanitizeDomainGuess(companyName),
    sourceText: sourceText.trim(),
  };
}

export function sanitizeDomainGuess(companyName: string): string {
  const cleaned = cleanCompanyForDomainSearch(companyName)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9-]/g, "");
  return cleaned ? `${cleaned}.com` : "";
}

export type GatedCompanyAttributionOptions = {
  signal?: AbortSignal;
  logEvent?: (msg: string) => void;
  circuitBreaker?: any;
  timeoutMs?: number;
  batchSize?: number;
  persistentCache?: boolean;
  openAIStructured?: (
    prompt: string,
    schema: any,
    systemInstruction?: string,
    options?: any,
  ) => Promise<any>;
};

const companyAttributionCache = new Map<
  string,
  { result: CompanyAttributionResult; sourceLength: number }
>();
const MAX_COMPANY_ATTRIBUTION_CACHE = 1000;

function buildCompanyAttributionCacheKey(
  companyKey: string,
  contract: ProspectContract,
): string {
  const briefKey = String(contract.brief || "").trim().toLowerCase();
  const policyKey = String(contract.policyVersion || "");
  const reqKey = (contract.requirements || [])
    .map((r) => `${r.id}:${r.importance}:${r.scope}:${r.description}`)
    .join("|")
    .toLowerCase();
  return `${companyKey.toLowerCase()}::${policyKey}::${briefKey}::${reqKey}`;
}

/**
 * Stored company facts are brief-independent. Reusing them never decides fit:
 * the facts become judge evidence and the finalist judge applies the brief.
 */
export function attributionFromStoredProfile(profile: StoredCompanyProfile): CompanyAttributionResult {
  return {
    companyDomain: profile.companyKey,
    companyName: profile.companyName,
    businessModel: profile.businessModel as CompanyBusinessModel,
    industry: profile.industry,
    primaryOffering: profile.primaryOffering,
    queryAlignment: "adjacent",
    verbatimEvidenceQuote: profile.quoteVerified ? profile.evidenceQuote : "",
    verdict: "unverified",
    reason: "Stored company profile reused; fit is decided by the finalist judge.",
    quoteVerified: profile.quoteVerified,
    fromStoredProfile: true,
  };
}

function applyAttributionToGroup(
  groupTargets: Array<{
    candidate: FinalistCandidate;
    companyKey: string;
    companyName: string;
    domain: string;
    sourceText: string;
  }>,
  attributionResult: CompanyAttributionResult,
  summary: {
    attributedCount: number;
    contradictionCount: number;
    verifiedCount: number;
  },
): void {
  const { verdict, verbatimEvidenceQuote: citedQuote, quoteVerified: quoteValid } =
    attributionResult;
  const first = groupTargets[0];

  summary.attributedCount += groupTargets.length;
  if (verdict === "disqualifying_contradiction") {
    summary.contradictionCount += groupTargets.length;
  } else if (verdict === "verified_fit") {
    summary.verifiedCount += groupTargets.length;
  }

  for (const target of groupTargets) {
    const lead = target.candidate.lead;
    lead.companyAttribution = attributionResult;

    if (verdict === "disqualifying_contradiction") {
      lead._autoFailed = true;
      lead._contradictionReason = `Company Attribution: ${attributionResult.reason} (business model: ${attributionResult.businessModel})`;
    } else if (verdict === "verified_fit" || attributionResult.fromStoredProfile) {
      const quoteSnippet = quoteValid && citedQuote ? ` Quote: "${citedQuote}".` : "";
      const attrEvidenceItem = {
        id: "e_company_attr",
        text: `[COMPANY ATTRIBUTION (${verdict}): ${first.domain || first.companyName}] Business Model: ${attributionResult.businessModel}.${attributionResult.industry ? ` Industry: ${attributionResult.industry}.` : ""} Offering: ${attributionResult.primaryOffering}.${quoteSnippet} Reason: ${attributionResult.reason}`,
      };
      const existingEvidence = (target.candidate.evidence || []).filter(
        (item) => item?.id !== "e_company_attr",
      );
      target.candidate.evidence = [attrEvidenceItem, ...existingEvidence];
      if (lead.companyAccount) {
        lead.companyAccount.businessModel = attributionResult.businessModel;
        if (attributionResult.primaryOffering) {
          lead.companyAccount.description = attributionResult.primaryOffering;
        }
      }
    }
  }
}

export async function runGatedCompanyAttribution(
  candidates: FinalistCandidate[],
  contract: ProspectContract,
  options: GatedCompanyAttributionOptions = {},
): Promise<{
  attributedCount: number;
  contradictionCount: number;
  verifiedCount: number;
}> {
  const result = {
    attributedCount: 0,
    contradictionCount: 0,
    verifiedCount: 0,
  };

  if (!candidates || candidates.length === 0) return result;

  // Identify candidates requiring company attribution:
  // Must have a company name and available company source text
  type CandidateTarget = {
    candidate: FinalistCandidate;
    companyKey: string;
    companyName: string;
    domain: string;
    sourceText: string;
  };

  const targets: CandidateTarget[] = [];
  for (const cand of candidates) {
    if (cand.lead._autoFailed) continue;
    if (cand.lead.companyAttribution) continue;
    const { companyName, domain, sourceText } = extractCompanySourceText(cand);
    if (!companyName || sourceText.length < 30) continue;
    const companyKey = domain || companyName.toLowerCase();
    targets.push({
      candidate: cand,
      companyKey,
      companyName,
      domain,
      sourceText,
    });
  }

  if (targets.length === 0) return result;

  // Group candidates by unique companyKey (1-to-many deduplication)
  const byCompany = new Map<string, CandidateTarget[]>();
  for (const target of targets) {
    const list = byCompany.get(target.companyKey) || [];
    list.push(target);
    byCompany.set(target.companyKey, list);
  }

  const useCache = !options.openAIStructured;
  const usePersistent = options.persistentCache ?? !options.openAIStructured;
  const requirementHash = computeRequirementsFingerprint(contract.requirements);
  const uniqueCompanyEntries: Array<[string, CandidateTarget[]]> = [];
  for (const [key, groupTargets] of byCompany.entries()) {
    if (useCache) {
      const cacheKey = buildCompanyAttributionCacheKey(key, contract);
      const cached = companyAttributionCache.get(cacheKey);
      const currentSourceLen = groupTargets[0]?.sourceText.length || 0;
      if (
        cached &&
        (cached.result.verdict !== "unverified" ||
          cached.sourceLength >= currentSourceLen)
      ) {
        applyAttributionToGroup(groupTargets, cached.result, result);
        continue;
      }
    }
    if (usePersistent) {
      const currentSourceLen = groupTargets[0]?.sourceText.length || 0;
      const stored = getCompanyAttributionVerdict(key, requirementHash);
      if (stored && (stored.result.verdict !== "unverified" || stored.sourceLength >= currentSourceLen)) {
        applyAttributionToGroup(groupTargets, stored.result as CompanyAttributionResult, result);
        continue;
      }
      const profile = getCompanyProfile(key);
      if (profile && profile.sourceLength >= currentSourceLen) {
        applyAttributionToGroup(groupTargets, attributionFromStoredProfile(profile), result);
        continue;
      }
    }
    uniqueCompanyEntries.push([key, groupTargets]);
  }

  if (uniqueCompanyEntries.length === 0) return result;

  if (options.logEvent) {
    options.logEvent(
      `[Company Attribution] Evaluating ${uniqueCompanyEntries.length} unique companies for ${targets.length} ambiguous candidates.`,
    );
  }

  // Micro-batch up to batchSize (default 4, configurable up to 8) companies per LLM call
  const BATCH_SIZE = Math.max(
    1,
    Math.min(
      8,
      Number(options.batchSize || process.env.COMPANY_ATTRIBUTION_BATCH_SIZE || 4),
    ),
  );
  const structuredFn = options.openAIStructured || openAIStructured;
  for (let i = 0; i < uniqueCompanyEntries.length; i += BATCH_SIZE) {
    if (options.signal?.aborted) break;
    const batch = uniqueCompanyEntries.slice(i, i + BATCH_SIZE);

    const promptText = [
      `Search brief: "${contract.brief}"`,
      `Target requirements: ${(contract.requirements || []).map((r) => `[${r.importance}/${r.scope}] ${r.description}`).join("; ")}`,
      "",
      "Companies to evaluate:",
      ...batch.map(([key, groupTargets]) => {
        const first = groupTargets[0];
        const repTitles = Array.from(
          new Set(
            groupTargets.map((t) =>
              String(t.candidate.lead.currentTitle || t.candidate.lead.title || "").trim(),
            ),
          ),
        ).filter(Boolean);
        // Scale source text allowance dynamically based on batch size (more context when fewer companies are in the batch)
        const dynamicSourceChars = Math.max(
          1200,
          Math.floor(9600 / Math.max(1, batch.length)),
        );
        const truncatedText = first.sourceText
          .slice(0, dynamicSourceChars)
          .replace(/\s+/g, " ");
        return [
          `--- COMPANY KEY: ${key} ---`,
          `Company Name: ${first.companyName}`,
          `Domain: ${first.domain || "unknown"}`,
          `Associated Candidate Titles: ${repTitles.join(" | ") || "Executive / Founder"}`,
          `Source Text: "${truncatedText}"`,
        ].join("\n");
      }),
      "",
      "For each company, evaluate businessModel, queryAlignment, verdict, verbatimEvidenceQuote, and reason.",
    ].join("\n");

    try {
      const dynamicAttributionTokens = Math.max(1200, batch.length * 400);
      const response = (await runWithLlmStageLane("judge", () =>
        structuredFn(
          promptText,
          bulkCompanyAttributionSchema,
          COMPANY_ATTRIBUTION_SYSTEM_PROMPT,
          {
            temperature: 0.0,
            maxTokens: dynamicAttributionTokens,
            signal: options.signal,
            circuitBreaker: options.circuitBreaker,
            timeoutMs: options.timeoutMs ?? 45_000,
            metadata: {
              stage: "company_attribution",
              itemCount: batch.length,
              promptSize: promptText.length,
            },
          },
        ),
      )) as { attributions?: any[] } | null | undefined;

      const rawAttributions = Array.isArray(response?.attributions)
        ? response.attributions
        : [];

      for (const [key, groupTargets] of batch) {
        const attr = rawAttributions.find(
          (a) =>
            a &&
            (String(a.companyKey).toLowerCase() === key.toLowerCase() ||
              (firstDomain(key) && String(a.companyKey).toLowerCase().includes(firstDomain(key)))),
        );
        if (!attr) continue;

        const first = groupTargets[0];
        // Enforce citation verification on verbatimEvidenceQuote
        let quoteValid = false;
        const citedQuote = String(attr.verbatimEvidenceQuote || "").trim();
        if (citedQuote && citedQuote.length >= 8) {
          const passageCheck = verifyEvidencePassage(first.sourceText, citedQuote);
          quoteValid = passageCheck.valid;
        }

        let verdict: CompanyAttributionVerdict =
          attr.verdict === "disqualifying_contradiction"
            ? "disqualifying_contradiction"
            : attr.verdict === "verified_fit"
            ? "verified_fit"
            : "unverified";

        // If verdict claims verified fit but fabricated the quote, downgrade to unverified
        if (verdict === "verified_fit" && !quoteValid && citedQuote.length > 0) {
          verdict = "unverified";
        }

        const attributionResult: CompanyAttributionResult = {
          companyDomain: first.domain,
          companyName: first.companyName,
          businessModel: (attr.businessModel || "other") as CompanyBusinessModel,
          industry: String(attr.industry || "").trim(),
          primaryOffering: String(attr.primaryOffering || "").trim(),
          queryAlignment: attr.queryAlignment || "adjacent",
          verbatimEvidenceQuote: quoteValid ? citedQuote : "",
          verdict,
          reason: String(attr.reason || "").trim(),
          quoteVerified: quoteValid,
        };

        if (useCache) {
          if (companyAttributionCache.size >= MAX_COMPANY_ATTRIBUTION_CACHE) {
            const oldestKey = companyAttributionCache.keys().next().value;
            if (oldestKey !== undefined) companyAttributionCache.delete(oldestKey);
          }
          companyAttributionCache.set(
            buildCompanyAttributionCacheKey(key, contract),
            {
              result: attributionResult,
              sourceLength: first.sourceText.length,
            },
          );
        }

        if (usePersistent) {
          upsertCompanyAttributionVerdict(key, requirementHash, attributionResult, first.sourceText.length);
          // Only quote-verified facts are reused across briefs; sparse or fabricated ones are not.
          if (attributionResult.quoteVerified) {
            upsertCompanyProfile({
              companyKey: key,
              companyName: first.companyName,
              businessModel: attributionResult.businessModel,
              industry: attributionResult.industry || "",
              primaryOffering: attributionResult.primaryOffering,
              evidenceQuote: attributionResult.verbatimEvidenceQuote,
              quoteVerified: true,
              sourceLength: first.sourceText.length,
            });
          }
        }

        applyAttributionToGroup(groupTargets, attributionResult, result);
      }
    } catch (err: any) {
      if (options.logEvent) {
        options.logEvent(
          `WARN: Gated company attribution batch failed: ${err.message || String(err)}`,
        );
      }
    }
  }

  return result;
}

function firstDomain(key: string): string {
  try {
    return new URL(`https://${key}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
