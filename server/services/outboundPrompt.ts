export interface BuildOutboundPromptOptions {
  leadId?: string;
  profile: any;
  tone?: string;
  pitchType?: string;
  valueProposition?: string;
  senderName?: string;
  senderCompany?: string;
  sequenceStep?: string;
  customInstruction?: string;
  companyAccount?: any;
  buyingSignals?: any;
  buyingSignalsDetected?: any;
  evidence?: any;
  qualification?: any;
  postIntentEvidence?: any;
  companyIntentEvidence?: any;
  notes?: string;
  priorDraftSummary?: string;
  styleExemplars?: string;
}

export function buildOutboundPrompt(options: BuildOutboundPromptOptions): string {
  const {
    profile,
    tone,
    pitchType,
    valueProposition,
    senderName,
    senderCompany,
    sequenceStep,
    customInstruction,
    companyAccount,
    buyingSignals,
    buyingSignalsDetected,
    evidence,
    qualification,
    postIntentEvidence,
    companyIntentEvidence,
    notes,
    priorDraftSummary = "No prior sequence touchpoints recorded.",
    styleExemplars = "",
  } = options;

  const buyingSignalText = Array.isArray(buyingSignals)
    ? buyingSignals
        .map((signal) =>
          typeof signal === "string"
            ? signal
            : [signal?.label, signal?.evidence].filter(Boolean).join(": "),
        )
        .filter(Boolean)
        .join("; ")
    : typeof buyingSignals === "string"
      ? buyingSignals
      : "";

  const evidenceSnippets = Array.isArray(evidence?.snippets)
    ? evidence.snippets
        .map((s: any) => (typeof s === "string" ? s : s?.text || ""))
        .filter(Boolean)
        .join(" | ")
    : typeof evidence?.evidenceBlock === "string"
      ? evidence.evidenceBlock.slice(0, 1000)
      : "";

  const postIntentSnippets =
    Array.isArray(postIntentEvidence?.recentPosts) &&
    postIntentEvidence.recentPosts.length > 0
      ? postIntentEvidence.recentPosts
          .map((p: any) =>
            typeof p === "string"
              ? p
              : [
                  p.topic ? `Topic: ${p.topic}` : "",
                  p.quote ? `Quote: "${p.quote}"` : "",
                  p.postDate ? `Date: ${p.postDate}` : "",
                ]
                  .filter(Boolean)
                  .join(" | "),
          )
          .filter(Boolean)
          .join("\n")
      : typeof postIntentEvidence?.summary === "string"
        ? postIntentEvidence.summary
        : "";

  const companyIntentSnippets = Array.isArray(companyIntentEvidence?.snippets)
    ? companyIntentEvidence.snippets.join(" | ")
    : "";

  const hiringTriggers = [
    ...(Array.isArray(buyingSignalsDetected) ? buyingSignalsDetected : []),
    ...(Array.isArray(profile?.buyingSignalsDetected)
      ? profile.buyingSignalsDetected
      : []),
    ...(Array.isArray(buyingSignals)
      ? buyingSignals.map((s: any) =>
          typeof s === "string" ? s : s?.label,
        )
      : []),
    ...(Array.isArray(companyAccount?.buyingSignals)
      ? companyAccount.buyingSignals.map((s: any) =>
          typeof s === "string" ? s : s?.label,
        )
      : []),
  ].filter(
    (s): s is string =>
      typeof s === "string" &&
      (s.toLowerCase().includes("hiring") ||
        s.toLowerCase().includes("job requisition")),
  );
  const liveHiringTrigger = hiringTriggers[0] || "";

  const qualificationVerdict =
    qualification?.explanation || qualification?.verdict || "";
  const prospectNotes = typeof notes === "string" ? notes.trim() : "";

  return `Generate a highly personalized outreach message for the following prospect.

## Prospect Profile
- Name: ${profile.fullName}
- Title: ${profile.currentTitle} at ${profile.currentCompany}
- Industry: ${profile.industry || "Unknown"}
- Location: ${profile.location || "Unknown"}
- Seniority: ${profile.seniorityLevel || "Unknown"}
- Company Size: ${profile.companySizeEst || "Unknown"}
- Summary: ${profile.summary || ""}
- Pain Indicators: ${(profile.painIndicators || []).join(", ") || "None listed"}
- Career Signals: ${(profile.careerSignals || []).join(", ") || "None listed"}
- Tech Stack: ${(profile.techStackHints || []).join(", ") || "Unknown"}
- Buying Signals: ${buyingSignalText || "None provided"}

## Verified Real-World Triggers & Evidence
- Active ATS Job Requisition / Live Headcount Trigger: ${liveHiringTrigger || "None active"}
- Prospect Authored LinkedIn Posts & Quotes: ${postIntentSnippets || "None available"}
- Company Intent & Website Signals: ${companyIntentSnippets || "None available"}
- Mined Evidence & Observations: ${evidenceSnippets || "None available"}
- Qualification Verdict & Match Context: ${qualificationVerdict || "None"}
- CRM Notes: ${prospectNotes || "None"}

## Sequence & Conversation Thread History
- Current Step: ${sequenceStep || "Step 1 - First Touch"}
- Prior Touchpoints in Thread:
${priorDraftSummary}

## Approved Style Calibration (User Preference Exemplars)
${styleExemplars || "Write in crisp, concise, high-signal modern B2B tone."}

## Campaign Settings
- Tone: ${tone || "Professional"}
- Pitch Type: ${pitchType || "Cold outreach"}
- Value Proposition: ${valueProposition || "Not specified"}
- Sender: ${senderName || "Sales Rep"} from ${senderCompany || "Our Company"}
- Custom Instruction: ${customInstruction || "None"}
- Channel: ${companyAccount ? "Company LinkedIn Account" : "Personal LinkedIn / Email"}

## Output Requirements
Return plain text only. Do not use HTML, markdown, or unsupported performance claims.
Follow the Golden Rules strictly:
1. Never start with "I"
2. Be specific - lead with or reference verified real-world facts from their recent LinkedIn posts, hiring signals, or website observations
3. If this is a follow-up step (> Step 1), advance the conversation thread naturally from prior touchpoints rather than repeating the first pitch
4. One CTA only
5. LinkedIn connection note: max 300 characters
6. Cold email: max 150 words
7. No spam words: guaranteed, synergy, leverage, disruptive, game-changing, revolutionary

Use normal paragraph breaks so the result can be pasted into email, LinkedIn, or a mailto link.`;
}
