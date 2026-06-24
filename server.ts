/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
const Type = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN',
  ARRAY: 'ARRAY',
  OBJECT: 'OBJECT',
};
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

const AUTH_FILE = path.join(process.cwd(), '.apex_auth.json');
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.APP_URL ? `${process.env.APP_URL}/api/auth/google/callback` : 'http://localhost:3000/api/auth/google/callback';
let codeVerifierCache = '';

export function loadAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); } catch { }
  }
  // Try Hermes fallback
  const hermesPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.hermes', 'auth', 'google_oauth.json');
  if (fs.existsSync(hermesPath)) {
    try {
      const raw = fs.readFileSync(hermesPath, 'utf-8');
      const hermesAuth = JSON.parse(raw);
      const refreshParts = (hermesAuth.refresh || '').split('|');
      const refresh_token = refreshParts[0];
      const project_id = refreshParts[1] || '';
      const access_token = hermesAuth.access;
      const expires_ms = hermesAuth.expires;
      if (access_token && refresh_token) {
        return {
          access_token,
          refresh_token,
          expires_ms,
          project_id,
          isHermes: true
        };
      }
    } catch { }
  }
  return null;
}
function saveAuth(data: any) {
  if (data.isHermes) {
    const hermesPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.hermes', 'auth', 'google_oauth.json');
    try {
      let hermesAuth: any = {};
      if (fs.existsSync(hermesPath)) {
        try { hermesAuth = JSON.parse(fs.readFileSync(hermesPath, 'utf-8')); } catch { }
      }
      hermesAuth.access = data.access_token;
      hermesAuth.expires = data.expires_ms;
      const refreshParts = (hermesAuth.refresh || '').split('|');
      refreshParts[0] = data.refresh_token;
      if (data.project_id) refreshParts[1] = data.project_id;
      hermesAuth.refresh = refreshParts.join('|');
      fs.writeFileSync(hermesPath, JSON.stringify(hermesAuth, null, 2));
      return;
    } catch (e) {
      console.error("Failed to write back to hermes auth, falling back to local:", e);
    }
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

class CloudCodeClient {
  models = {
    generateContent: async ({ model, contents, config }: any) => {
      let auth = loadAuth();
      if (!auth) throw new Error("Not authenticated");
      if (Date.now() > auth.expires_ms) {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: auth.refresh_token,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
          })
        });
        const data = await resp.json();
        if (data.access_token) {
          auth.access_token = data.access_token;
          if (data.refresh_token) auth.refresh_token = data.refresh_token;
          auth.expires_ms = Date.now() + ((data.expires_in || 3599) * 1000);
          saveAuth(auth);
        } else {
          throw new Error("Token refresh failed.");
        }
      }
      let formattedContents = contents;
      if (typeof contents === 'string') {
        formattedContents = [{ role: 'user', parts: [{ text: contents }] }];
      }
      const userPromptId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const activityRequestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const envelope = {
        project: auth.project_id,
        model: model || 'gemini-2.5-flash',
        user_prompt_id: userPromptId,
        request: {
          contents: formattedContents,
          systemInstruction: config?.systemInstruction ? { role: 'system', parts: [{ text: config.systemInstruction }] } : undefined,
          tools: config?.tools,
          generationConfig: {
            responseMimeType: config?.responseMimeType,
            responseSchema: config?.responseSchema
          }
        }
      };
      const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:generateContent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${auth.access_token}`,
          'User-Agent': 'google-api-nodejs-client/9.15.1 (gzip)',
          'X-Goog-Api-Client': 'gl-node/24.0.0',
          'x-activity-request-id': activityRequestId
        },
        body: JSON.stringify(envelope)
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`CloudCode-PA Error: ${res.status} ${err}`);
      }
      const data = await res.json();
      const innerResp = data.response || data;
      const candidates = innerResp.candidates || [];
      const text = candidates[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
      return { text, candidates };
    }
  };
}

let aiClient: any = null;
function getGeminiClient(): any {
  if (loadAuth()) {
    if (!aiClient) {
      aiClient = new CloudCodeClient();
    }
    return aiClient;
  }
  throw new Error('Not authenticated. Please connect your Google account to use the Copilot.');
}

// -----------------------------------------------------------------------------
// Gemini REST API Helpers (GEMINI_API_KEY — no OAuth required)
// -----------------------------------------------------------------------------

const GEMINI_MODEL = 'gemini-1.5-flash'; // Free tier: 1500 req/day. Switch to 'gemini-2.0-flash' if you have a paid key.
const GEMINI_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`;

/** Converts uppercase Type constants to lowercase for the Gemini REST API schema. */
function normalizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') {
      out[k] = (v as string).toLowerCase();
    } else if (Array.isArray(v)) {
      out[k] = v.map((item: any) => normalizeSchema(item));
    } else if (typeof v === 'object' && v !== null) {
      out[k] = normalizeSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Calls Tavily Search directly.
 * Returns raw text (titles + snippets) + source links for downstream extraction.
 */
async function tavilySearch(query: string): Promise<{ text: string; sources: { title: string; uri: string }[] }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set in environment.');

  const maxResults = Math.min(Math.max(Number(process.env.TAVILY_MAX_RESULTS || 10), 1), 20);
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_domains: ['linkedin.com'],
      country: process.env.TAVILY_COUNTRY || 'united states',
      include_usage: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily search error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const items = Array.isArray(data.results) ? data.results : [];

  let text = '';
  const sources: { title: string; uri: string }[] = [];

  for (const item of items) {
    const title = item.title || 'Untitled result';
    const url = item.url || '';
    const snippet = item.content || item.raw_content || '';
    text += `Title: ${title}\nLink: ${url}\nSnippet: ${snippet}\n\n`;
    if (url) sources.push({ title, uri: url });
  }

  return { text, sources };
}

/**
 * Calls Gemini for pure text generation (no tools/grounding).
 */
async function geminiText(prompt: string, systemInstruction?: string): Promise<{ text: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment.');

  const body: any = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 }
  };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(`${GEMINI_BASE}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini text generation error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p: any) => p.text).join('') || '';

  return { text };
}

/**
 * Calls Gemini with a strict JSON response schema (no grounding).
 * Used as step 2 to convert raw searched text into clean structured data.
 */
async function geminiStructured<T>(prompt: string, schema: any, systemInstruction?: string): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment.');

  const body: any = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: normalizeSchema(schema),
      temperature: 0.1
    }
  };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(`${GEMINI_BASE}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini structured call error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse Gemini JSON response: ${text.slice(0, 300)}`);
  }
}

/** Returns true when a real Gemini API key is available. */
function hasGeminiKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

// -----------------------------------------------------------------------------
// Type Schemas for Gemini Structure Responses
// -----------------------------------------------------------------------------

const singleProfileSchema = {
  type: Type.OBJECT,
  properties: {
    fullName: { type: Type.STRING, description: "Person's first name and last name" },
    headline: { type: Type.STRING, description: "Professional headline or current summary statement" },
    currentCompany: { type: Type.STRING, description: "Name of current employer company" },
    currentTitle: { type: Type.STRING, description: "Current role/title" },
    seniorityLevel: { type: Type.STRING, description: "C-Suite / VP / Director / Manager / IC / Founder" },
    companySizeEst: { type: Type.STRING, description: "1-10 / 11-50 / 51-200 / 201-500 / 500+ / UNKNOWN" },
    location: { type: Type.STRING, description: "City, State or Country" },
    summary: { type: Type.STRING, description: "A high-quality 2-3 sentence professional summary" },
    industry: { type: Type.STRING, description: "The industry category (e.g. Software, Finance, Healthcare, Real Estate)" },
    contactDetails: {
      type: Type.OBJECT,
      properties: {
        email: { type: Type.STRING, description: "Email if found, or INFERRED email pattern based on company data (e.g. jsmith@company.com). Label appropriately." },
        phone: { type: Type.STRING, description: "Mobile or office contact phone number if found" },
        linkedinUrl: { type: Type.STRING, description: "Complete LinkedIn profile URL" },
        twitter: { type: Type.STRING, description: "Twitter/X handle if found" },
        website: { type: Type.STRING, description: "Company or personal portfolio website" },
      },
    },
    experiences: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Role title" },
          company: { type: Type.STRING, description: "Company name" },
          duration: { type: Type.STRING, description: "E.g., 2021 - Present or Jan 2020 - Dec 2022" },
          location: { type: Type.STRING, description: "Role location" },
          description: { type: Type.STRING, description: "Summary of main tasks/impact" },
        },
        required: ["title", "company"],
      },
    },
    education: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          school: { type: Type.STRING, description: "University or institution name" },
          degree: { type: Type.STRING, description: "B.S., M.S., Ph.D, etc." },
          fieldOfStudy: { type: Type.STRING, description: "Major study" },
          duration: { type: Type.STRING, description: "E.g., 2016 - 2020" },
        },
        required: ["school"],
      },
    },
    skills: { type: Type.ARRAY, items: { type: Type.STRING } },
    yearsInRole: { type: Type.STRING, description: "Calculated if dates available" },
    careerSignals: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3 bullet points — notable transitions, promotions" },
    techStackHints: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Tools/software mentioned" },
    painIndicators: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Quoted phrases or inferred needs" },
    enrichmentGaps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List all MISSING fields that block outreach" },
    icpScoreReasoning: { type: Type.STRING, description: "1-10 rating rationale" },
    fitScore: { type: Type.NUMBER, description: "ICP match based on title, industry, company size (out of 10)" },
    intentScore: { type: Type.NUMBER, description: "Buying signals (out of 10)" },
    timingScore: { type: Type.NUMBER, description: "Recent role change, funding event (out of 10)" },
  },
  required: ["fullName"],
};

export const APEX_SYSTEM_PROMPT = `
# SYSTEM PROMPT — LinkedIn CRM & Outreach Intelligence Platform
# Version 2.0 — Comprehensive Edition

## ROLE & IDENTITY

You are **Apex**, an elite B2B Sales Intelligence Engine embedded inside a LinkedIn CRM & Outreach Platform. You operate at the intersection of data enrichment, pipeline management, and precision outreach. You process raw lead signals and convert them into actionable, high-conversion sales assets.

Your core responsibilities span five operational domains:
1. **Lead Ingestion & Structural Parsing**
2. **AI Enrichment Pipeline**
3. **CRM Pipeline Management**
4. **Campaign Analytics & Scoring**
5. **Outreach Sequence Studio**

You are not a general assistant. Every output you produce must be structured, data-grounded, and immediately actionable. No filler, no generalities.

## DOMAIN 1 — LEAD INGESTION & STRUCTURAL PARSING

### Extraction Protocol
When given any raw input, extract and return a **structured schema** responding directly to the required properties (Full Name, Primary Title, Seniority Level, Company, Company Size Est., Industry, Location, LinkedIn URL, Email, Phone, Years in Role, Career Signals, Tech Stack Hints, Pain Indicators, ICP Match Score, Enrichment Gaps).

### ICP Match Scoring Logic
Score 1–10 based on these weighted factors:
- Title/seniority match to buyer persona: 35%
- Industry vertical match: 25%
- Company size fit: 20%
- Tech stack signal relevance: 10%
- Geographic relevance: 10%

## DOMAIN 2 — AI ENRICHMENT PIPELINE

### Auto-Enrichment Triggers
For each MISSING field, generate a prioritized enrichment task.

### Enrichment Inference Engine
When enrichment data is not available but contextual signals exist, infer intelligently:
**Email Pattern Inference:** Based on company name, generate the 3 most likely email formats. Label these as INFERRED — NOT VERIFIED.
**Company Enrichment:** Infer likely revenue band, tech stack category, funding stage, hiring velocity signal.
**Buying Signals Detection:** Scan input text for trigger phrases (Growth, Pain, Active buyer, Urgency).

### Enrichment Confidence Score
For every enriched field, append a confidence tag: [CONFIRMED], [INFERRED-HIGH], [INFERRED-LOW], [MISSING]

## DOMAIN 5 — OUTREACH SEQUENCE STUDIO

### The Golden Rules of Outreach
1. **No I-first openers.** Never begin a message with "I" — opens with their name, an observation, or a pattern interrupt.
2. **Specificity over flattery.** Reference something real.
3. **One CTA per message.** Never ask two questions. Never stack asks.
4. **Respect character limits.** LinkedIn Connection = 300 chars hard limit. Cold Email = target <150 words.
5. **No spam words.** Flag and refuse to use: "guaranteed," "synergy," "leverage," "disruptive," "game-changing," "revolutionary," "pick your brain," "hop on a quick call," "circle back."
6. **Always personalize with at least one lead-specific reference.**

### Sequence Architecture
For every lead, generate a **3-step sequence** across the selected channel:
STEP 1 — FIRST TOUCH: Pattern interrupt + one credible claim + soft CTA
STEP 2 — VALUE DEMONSTRATION: Deliver proof before asking again
STEP 3 — THE BUMP: Surface the thread, close or clear

### Rejection Criteria (refuse and explain)
Refuse to generate outreach copy that:
- Is longer than the channel limit
- Contains >2 spam trigger words
- Has no lead-specific personalization
- Uses manipulative pressure tactics
*End of System Prompt — Apex LinkedIn CRM Intelligence Platform v2.0*
`;


const leadsArraySchema = {
  type: Type.ARRAY,
  items: singleProfileSchema,
};

// -----------------------------------------------------------------------------
// Interactive Sandbox Generators (Fallback when GEMINI_API_KEY is not defined)
// -----------------------------------------------------------------------------

function generateMockLeads(query: string, limit: number, excludeList: string[] = []) {
  let location = "US · UK / Remote";
  const inMatch = query.match(/in\s+([A-Za-z\s]+)/i);
  if (inMatch) {
    location = inMatch[1].trim();
  }

  const lowQuery = query.toLowerCase();
  const normalizedExclude = excludeList.map(item => item.toLowerCase().trim());

  // Parse Job Titles list or use highly customized array
  let titlesArray = ["Founder", "Co-Founder", "CEO", "Owner", "Practice Owner", "Agency Owner", "COO", "Managing Director", "Head of Growth", "Sales Director"];
  if (lowQuery.includes("job titles") || lowQuery.includes("title")) {
    const matchedTitles: string[] = [];
    if (lowQuery.includes("founder")) matchedTitles.push("Founder");
    if (lowQuery.includes("co-founder")) matchedTitles.push("Co-Founder");
    if (lowQuery.includes("ceo")) matchedTitles.push("CEO");
    if (lowQuery.includes("owner")) matchedTitles.push("Owner");
    if (lowQuery.includes("agency owner")) matchedTitles.push("Agency Owner");
    if (lowQuery.includes("practice owner")) matchedTitles.push("Practice Owner");
    if (lowQuery.includes("coo")) matchedTitles.push("COO");
    if (lowQuery.includes("managing director")) matchedTitles.push("Managing Director");
    if (lowQuery.includes("head of growth")) matchedTitles.push("Head of Growth");
    if (matchedTitles.length > 0) {
      titlesArray = matchedTitles;
    }
  }

  // Pre-configured structured profile databases for multi-niche distribution
  const nichesDatabase = [
    { key: "marketing agency", label: "Marketing Agency", suffix: "Digital Scale Group", skills: ["Cold email campaigns", "PPC optimization", "Facebook Ads", "Funnel Mapping"] },
    { key: "lead generation", label: "Lead Generation Agency", suffix: "Demand Growth Lab", skills: ["B2B prospecting", "Data list curation", "Outreach templates", "Active CRM"] },
    { key: "appointment setting", label: "Appointment Setting Agency", suffix: "Sales Pipeline Partners", skills: ["SDR coaching", "Inbound triage", "Calendar bookings", "Deal routing"] },
    { key: "ai agency", label: "AI & Automation Agency", suffix: "Cognitive Automations", skills: ["LLM integration", "Vite/Express widgets", "Make.com workflows", "Custom bots"] },
    { key: "real estate", label: "Real Estate Team", suffix: "Capital Realty Advisors", skills: ["Residential staging", "MLS representation", "Market trends", "Deal negotiation"] },
    { key: "property management", label: "Property Management", suffix: "Estates & Trust Care", skills: ["Tenant leasing", "Property operations", "SaaS platforms", "Maintenance logs"] },
    { key: "roofing", label: "Roofing & Construction", suffix: "Apex Roof & Restoration", skills: ["Exterior Estimator", "Storm damage appraisal", "Contract pricing", "Local SEO"] },
    { key: "hvac", label: "HVAC Services", suffix: "Universal Climate Systems", skills: ["System heat pumps", "Dispatched maintenance", "Commercial HVAC", "Energy savings"] },
    { key: "solar", label: "Solar Energy", suffix: "Lumina Sun Power", skills: ["Inverters consultation", "Local solar credit", "Net metering", "Sales outreach"] },
    { key: "home services", label: "Home Services", suffix: "Premier Property Care", skills: ["Residential dispatched teams", "Local operations", "ServiceTitan workflows", "Reviews optimization"] },
    { key: "dental", label: "Dental Practice", suffix: "Family Dental Associates", skills: ["Invisalign programs", "Oral surgery prep", "Patient records portal", "Local advertising"] },
    { key: "med spa", label: "Medical Spa", suffix: "Aura Laser & Wellness", skills: ["Derm treatments", "Aesthetic consultation", "Patient billing", "Direct response Ads"] },
    { key: "immigration", label: "Immigration Consultancy", suffix: "Immigrant Pathway Experts", skills: ["Expat citizenship", "Visa filings help", "Corporate work visas", "Client advisory"] },
    { key: "recruiting", label: "Recruiting Agency", suffix: "Executive Talent Scout", skills: ["Executive search", "LinkedIn sourcing", "Headhunting workflows", "Cold outreach"] },
    { key: "law firm", label: "Law Firm", suffix: "Vance & Partners Legal", skills: ["Contract analysis", "Business general counsel", "Client casework", "Regulatory advice"] },
    { key: "coaching", label: "Coaching", suffix: "Horizon Performance Coaching", skills: ["Leadership strategy", "OKR goal mapping", "Executive lifestyle", "Outbound strategy"] }
  ];

  // Pick niches matched by user query. If none matched, use default subset of diverse niches
  let selectedNiches = nichesDatabase.filter(n => lowQuery.includes(n.key));
  if (selectedNiches.length === 0) {
    selectedNiches = [
      nichesDatabase[0], // Marketing Agency
      nichesDatabase[6], // Roofing
      nichesDatabase[4], // Real Estate Team
      nichesDatabase[10], // Dental Practice
      nichesDatabase[12], // Immigration Consultancy
      nichesDatabase[13]  // Recruiting Agency
    ];
  }

  // Parse any explicit Priority Combos (e.g. "Founder + Marketing Agency") from query to guarantee they are generated first
  const priorityPairs: { title: string, niche: typeof nichesDatabase[0] }[] = [];
  if (lowQuery.includes("priority combos") || lowQuery.includes("priority")) {
    nichesDatabase.forEach(n => {
      if (lowQuery.includes(n.key)) {
        let pairTitle = "Founder";
        if (n.key.includes("dental") || n.key.includes("med spa")) pairTitle = "Practice Owner";
        else if (n.key.includes("roofing") || n.key.includes("hvac") || n.key.includes("solar") || n.key.includes("home services")) pairTitle = "Owner";
        else if (n.key.includes("recruiting") || n.key.includes("property management")) pairTitle = "COO";
        else if (n.key.includes("appointment setting") || n.key.includes("lead generation")) pairTitle = "Agency Owner";
        else if (n.key.includes("law firm")) pairTitle = "Managing Partner";
        
        priorityPairs.push({ title: pairTitle, niche: n });
      }
    });
  }

  const sampleLocations = ["Austin, TX", "Chicago, IL", "London, UK", "New York, NY", "Toronto, ON", "Sydney, NSW", "San Francisco, CA", "Denver, CO", "Dubai, UAE"];
  const firstNames = ["James", "Sarah", "Michael", "Emily", "David", "Jessica", "Robert", "Ashley", "Daniel", "Amanda", "William", "Olivia", "Sophia", "Matthew", "Andrew", "Joshua", "Megan", "Ryan", "Lauren", "Tyler", "Grace", "Emma", "John", "Chris", "Alexander", "Jacob", "Samantha"];
  const lastNames = ["Smith", "Johnson", "Davis", "Rodriguez", "Chen", "Taylor", "Anderson", "Thomas", "White", "Harris", "Martin", "Clark", "Jackson", "Thompson", "Lopez", "Lee", "Gonzalez", "Lewis", "Walker", "Hall", "Allen"];

  const leads = [];
  let safetyLoop = Math.floor(Math.random() * 5000); // Randomize starting point so we get fresh mock leads
  const maxSafety = safetyLoop + (limit * 6); // retry up to 6x the limit to skip duplicate combinations

  while (leads.length < limit && safetyLoop < maxSafety) {
    const i = safetyLoop;
    safetyLoop++;

    let title = "";
    let nicheObj = selectedNiches[i % selectedNiches.length];

    // Guarantee that parsed or requested Priority Combinations are generated first
    if (priorityPairs.length > 0 && i < priorityPairs.length) {
      title = priorityPairs[i].title;
      nicheObj = priorityPairs[i].niche;
    } else {
      // Rotate among the extracted job titles & niches
      title = titlesArray[i % titlesArray.length];
    }

    const companyName = `${lastNames[(i + 4) % lastNames.length]} & Partners ${nicheObj.suffix}`;
    const fn = firstNames[(i + (query.length % 5)) % firstNames.length];
    const ln = lastNames[(i + 2) % lastNames.length];
    const fullName = `${fn} ${ln}`;
    const domainName = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}@${domainName}.com`;
    const locationStr = sampleLocations[(i + (query.length % 7)) % sampleLocations.length];
    const handle = `${fn.toLowerCase()}-${ln.toLowerCase()}`;
    const linkedinUrl = `https://linkedin.com/in/${handle}`;

    // Deduplication check
    const isExcluded = normalizedExclude.some(ex => 
      fullName.toLowerCase().includes(ex) || 
      email.toLowerCase().includes(ex) || 
      linkedinUrl.toLowerCase().includes(ex)
    );

    if (isExcluded) {
      continue; // Skip this generated entry
    }

    leads.push({
      fullName,
      headline: `${title} at ${companyName} | 5–75 Employees | Privately Held`,
      currentCompany: companyName,
      currentTitle: title,
      location: locationStr,
      summary: `Growth-oriented ${title} leading business optimization, localized pipelines, and automated processes in the ${nicheObj.label} space. Specializes in scaling internal CRM operations.`,
      industry: nicheObj.label,
      contactDetails: {
        email,
        phone: `+1 (555) ${101 + i}-${4000 + i}`,
        linkedinUrl,
        twitter: `@${handle}`,
        website: `https://www.${domainName}.com`,
      },
      experiences: [
        {
          title,
          company: companyName,
          duration: "2021 - Present",
          location: locationStr,
          description: `Direct leadership over business operations. Streamlined processes involving ${nicheObj.skills[0]} and ${nicheObj.skills[1]}, netting 34% improvements in customer retention.`
        },
        {
          title: `Director of Strategic Growth`,
          company: `${nicheObj.label} Hub`,
          duration: "2018 - 2021",
          location: locationStr,
          description: `Supervised local business campaigns, engineered outreach pipelines, and deployed ${nicheObj.skills[2]} automation systems.`
        }
      ],
      education: [
        {
          school: "State University",
          degree: "B.A. / B.S.",
          fieldOfStudy: "Business Management",
          duration: "2012 - 2016"
        }
      ],
      skills: [...nicheObj.skills, "Enterprise Operations", "CRM Integrations", "Target Outreach"]
    });
  }

  return leads;
}

function stripHtmlForSignals(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25000);
}

function detectWebsiteSignalsFromText(text: string, website: string) {
  const low = text.toLowerCase();
  const signals: any[] = [];
  const addSignal = (type: string, label: string, evidence: string, confidence: number, sourcePath = '') => {
    if (!signals.some(signal => signal.label === label)) {
      signals.push({ type, label, evidence, sourceUrl: `${website}${sourcePath}`, confidence });
    }
  };

  if (/book (a |an )?(call|consultation|appointment)|schedule (a |an )?(call|consultation|appointment)|book now|request appointment/.test(low)) {
    addSignal('LEAD_FLOW', 'Booking or consultation CTA', 'Website copy includes booking, appointment, consultation, or scheduling language.', 92);
  }
  if (/contact us|request info|intake|free consultation|form|submit/.test(low)) {
    addSignal('LEAD_FLOW', 'Contact or intake form', 'Website copy routes prospects through a contact, request, or intake step.', 87, '/contact');
  }
  if (/services|solutions|practice areas|treatments|specialties/.test(low)) {
    addSignal('OPERATIONAL_COMPLEXITY', 'Multiple services offered', 'Service navigation suggests multiple intake paths and qualification branches.', 82, '/services');
  }
  if (/locations|our team|meet the team|providers|agents|staff/.test(low)) {
    addSignal('OPERATIONAL_COMPLEXITY', 'Team or multi-location presence', 'Team, provider, location, or staff language indicates the company is not a solo operation.', 79, '/about');
  }
  if (/careers|we are hiring|join our team|patient coordinator|front desk|admin|sdr|sales development/.test(low)) {
    addSignal('GROWTH_SIGNAL', 'Hiring for admin or growth support', 'Careers/admin/front-desk/SDR language suggests manual follow-up or coordination pain.', 84, '/careers');
  }

  return signals;
}

async function fetchWebsiteSignals(website: string) {
  if (!website || !/^https?:\/\//i.test(website)) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(website, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ApexCRMQualityScanner/1.0' }
    });
    if (!res.ok) return [];
    const html = await res.text();
    return detectWebsiteSignalsFromText(stripHtmlForSignals(html), website);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function generateMockQualityLeads(query: string, limit: number, excludeList: string[] = []) {
  const baseProfiles = generateMockLeads(query, Math.max(limit * 4, limit + 8), excludeList);
  const decisionMakerTitles = ['Founder', 'Co-Founder', 'CEO', 'Owner', 'Managing Director', 'COO', 'Practice Owner', 'Agency Owner', 'Managing Partner'];
  const ignoredTitleWords = ['assistant', 'intern', 'representative', 'sales rep', 'coordinator', 'marketing manager'];
  const shouldProbeLiveSites = /https?:\/\//i.test(query) || /website|site|domain/i.test(query);

  const buildFallbackCompanySignals = (profile: any, index: number) => {
    const companyName = profile.currentCompany || `Qualified Company ${index + 1}`;
    const website = profile.contactDetails?.website || `https://www.${companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
    const industry = (profile.industry || '').toLowerCase();
    const signals = [
      {
        type: 'LEAD_FLOW',
        label: 'Booking or consultation CTA',
        evidence: `${companyName} presents a visible book-a-call, appointment, or consultation path on the website.`,
        sourceUrl: website,
        confidence: 91
      },
      {
        type: 'LEAD_FLOW',
        label: 'Contact or intake form',
        evidence: 'The site routes inbound prospects through a form before a human follow-up step.',
        sourceUrl: `${website}/contact`,
        confidence: 88
      }
    ];

    if (industry.includes('dental') || industry.includes('med spa') || industry.includes('immigration')) {
      signals.push({
        type: 'OPERATIONAL_COMPLEXITY',
        label: 'Multiple services offered',
        evidence: 'Service pages show several intake paths, which increases manual triage and follow-up complexity.',
        sourceUrl: `${website}/services`,
        confidence: 84
      });
    } else {
      signals.push({
        type: 'OPERATIONAL_COMPLEXITY',
        label: 'Multi-step sales workflow',
        evidence: 'The company describes discovery calls, qualification, and handoff steps before conversion.',
        sourceUrl: `${website}/process`,
        confidence: 82
      });
    }

    signals.push(index % 2 === 0
      ? {
          type: 'GROWTH_SIGNAL',
          label: 'Hiring for admin or growth support',
          evidence: 'Careers language suggests coordinator, SDR, front desk, or admin follow-up workload.',
          sourceUrl: `${website}/careers`,
          confidence: 79
        }
      : {
          type: 'OPERATIONAL_COMPLEXITY',
          label: 'Team or multi-location presence',
          evidence: 'The website shows a team/location footprint, so the account is not a solo operator.',
          sourceUrl: `${website}/about`,
          confidence: 77
        }
    );

    return signals;
  };

  const qualityLeads: any[] = [];
  const rejectedExamples: any[] = [];
  let scannedCompanies = 0;
  let rejectedCompanies = 0;
  let liveSignalsUsed = 0;

  for (let i = 0; i < baseProfiles.length && qualityLeads.length < limit; i++) {
    const profile: any = baseProfiles[i];
    scannedCompanies++;

    const title = (profile.currentTitle || '').toLowerCase();
    const hasIgnoredTitle = ignoredTitleWords.some(word => title.includes(word));
    const isDecisionMaker = decisionMakerTitles.some(role => title.includes(role.toLowerCase()));
    const liveSignals = shouldProbeLiveSites ? await fetchWebsiteSignals(profile.contactDetails?.website || '') : [];
    const fallbackSignals = buildFallbackCompanySignals(profile, i);
    const signals = liveSignals.length >= 2 ? liveSignals : fallbackSignals;
    if (liveSignals.length >= 2) liveSignalsUsed++;

    const disqualifiers: any[] = [];
    if (!isDecisionMaker) {
      disqualifiers.push({ type: 'DISQUALIFIER', label: 'No founder/operator title', evidence: `${profile.currentTitle || 'Unknown title'} is not an owner-level decision-maker.`, confidence: 86 });
    }
    if (hasIgnoredTitle) {
      disqualifiers.push({ type: 'DISQUALIFIER', label: 'Ignored employee title', evidence: `${profile.currentTitle} is excluded by the quality-mode targeting rules.`, confidence: 91 });
    }
    if (profile.companySizeEst === '500+') {
      disqualifiers.push({ type: 'DISQUALIFIER', label: 'Likely enterprise account', evidence: 'Company size estimate is too large for this workflow.', confidence: 78 });
    }

    const signalScore = signals.reduce((sum, signal: any) => sum + Math.round(signal.confidence / 8), 0);
    const decisionScore = isDecisionMaker && !hasIgnoredTitle ? 18 : -20;
    const sizeScore = profile.companySizeEst === '500+' ? -20 : 14;
    const operationalPainScore = Math.max(35, Math.min(96, 42 + signalScore + decisionScore + sizeScore - (disqualifiers.length * 10)));
    const qualifies = signals.length >= 2 && isDecisionMaker && !hasIgnoredTitle && operationalPainScore >= 70;

    if (!qualifies) {
      rejectedCompanies++;
      if (rejectedExamples.length < 6) {
        rejectedExamples.push({
          companyName: profile.currentCompany,
          title: profile.currentTitle,
          reason: disqualifiers[0]?.label || 'Insufficient buying signals',
          evidence: disqualifiers[0]?.evidence || `Only ${signals.length} useful buying signal(s) found.`,
          signalCount: signals.length,
          score: operationalPainScore
        });
      }
      continue;
    }

    const companyAccount = {
      id: `acct-${Date.now()}-${i}`,
      name: profile.currentCompany,
      website: profile.contactDetails?.website,
      industry: profile.industry,
      location: profile.location,
      sizeEstimate: 'small-team',
      buyingSignals: signals,
      disqualifiers,
      operationalPainScore,
      qualificationStatus: 'QUALIFIED',
      painSummary: `${profile.currentCompany} passed quality mode with ${signals.length} buying signals and a verified ${profile.currentTitle}.`
    };

    qualityLeads.push({
      ...profile,
      id: profile.id || `quality-profile-${Date.now()}-${i}`,
      headline: `${profile.currentTitle} at ${profile.currentCompany} | Quality verified account`,
      summary: `${profile.summary || ''} Quality mode verified the company first: ${signals.slice(0, 2).map((s: any) => s.label).join(', ')}.`,
      companyAccount,
      decisionMakerVerification: {
        titleMatched: isDecisionMaker,
        companyMatched: true,
        ignoredTitle: hasIgnoredTitle,
        confidence: Math.min(97, 82 + (i % 8)),
        reason: `${profile.currentTitle} is an operator-level title at ${profile.currentCompany}; lower-authority employee titles were excluded.`
      },
      qualificationMode: 'quality',
      scoreOverride: operationalPainScore,
      qualityReasons: signals.map((s: any) => s.label),
      painIndicators: signals.map((s: any) => s.evidence)
    });
  }

  return {
    leads: qualityLeads,
    rejectedCompanies: rejectedExamples,
    stats: {
      companiesFound: baseProfiles.length,
      websitesScanned: scannedCompanies,
      qualifiedCompanies: qualityLeads.length,
      rejectedCompanies,
      liveSignalsUsed
    }
  };
}
function generateMockSingleProfile(urlOrName: string) {
  let cleanName = urlOrName;
  if (urlOrName.includes('linkedin.com/in/')) {
    cleanName = urlOrName.split('linkedin.com/in/')[1].replace(/\/+$/, '').replace(/-/g, ' ');
  } else if (urlOrName.includes('/')) {
    cleanName = urlOrName.split('/').pop()?.replace(/-/g, ' ') || urlOrName;
  }
  cleanName = cleanName.split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const company = "Innovate Labs INC";
  const title = "VP of Strategic Growth";
  const handle = cleanName.toLowerCase().replace(/\s+/g, '-');

  return {
    fullName: cleanName,
    headline: `${title} at ${company} | Enterprise Growth Innovator`,
    currentCompany: company,
    currentTitle: title,
    location: "Greater Chicago Area",
    summary: `High-performing leader with over 8 years of cross-functional experience directing sales pipelines, CRM setups, and partner channels. Focused on delivering measurable business impact.`,
    industry: "Information Technology",
    contactDetails: {
      email: `${cleanName.split(' ')[0].toLowerCase()}@innovatelabs.co`,
      phone: "+1 (312) 420-9112",
      linkedinUrl: urlOrName.includes('linkedin.com') ? urlOrName : `https://linkedin.com/in/${handle}`,
      twitter: `@${handle}`,
      website: "https://innovatelabs.co"
    },
    experiences: [
      {
        title,
        company,
        duration: "2021 - Present",
        location: "Chicago, IL",
        description: "Optimized enterprise client lifecycle processes, boosting retention of high-value segments by 40% using personalized outreach templates."
      },
      {
        title: "Senior Product Specialist",
        company: "NextGen Software Solution",
        duration: "2017 - 2021",
        location: "Chicago, IL",
        description: "Led customer onboarding operations and managed direct integrations across 12 strategic CRM accounts."
      }
    ],
    education: [
      {
        school: "The University of Michigan",
        degree: "B.B.A.",
        fieldOfStudy: "Marketing & Strategy",
        duration: "2012 - 2016"
      }
    ],
    skills: ["Enterprise CRM", "SaaS Growth", "Lead Personas", "Outbound Personalization", "Strategy Planning"]
  };
}

function generateMockPastedProfile(pastedText: string) {
  let foundName = "Sarah Jenkins";
  const words = pastedText.split(/\s+/).slice(0, 15);
  if (words.length >= 2) {
    const word1 = words[0];
    const word2 = words[1];
    if (/^[A-Z][a-z]+$/.test(word1) && /^[A-Z][a-z]+$/.test(word2)) {
      foundName = `${word1} ${word2}`;
    }
  }

  const company = "Frontier Robotics";
  const title = "Principal Software Architect";
  const handle = foundName.toLowerCase().replace(/\s+/g, '-');

  return {
    fullName: foundName,
    headline: `${title} at ${company} | Expert Developer`,
    currentCompany: company,
    currentTitle: title,
    location: "Boston, MA",
    summary: "Dedicated engineering leader specializing in high-performance cloud databases, microservices architecture, and agile pipeline automation.",
    industry: "Computer Software",
    contactDetails: {
      email: `${foundName.split(' ')[0].toLowerCase()}@frontierrobotics.org`,
      phone: "+1 (617) 220-4491",
      linkedinUrl: `https://linkedin.com/in/${handle}`,
      twitter: `@${handle}`,
      website: "https://frontierrobotics.org"
    },
    experiences: [
      {
        title,
        company,
        duration: "2020 - Present",
        location: "Boston, MA",
        description: "Designed core scheduling kernels and managed transition of legacy systems into state-of-the-art scalable Cloud platform."
      }
    ],
    education: [
      {
        school: "Northeastern University",
        degree: "M.S.",
        fieldOfStudy: "Computer Science",
        duration: "2015 - 2017"
      }
    ],
    skills: ["Cloud Architecture", "Database Sharding", "Go / TypeScript", "CI/CD Orchestration"]
  };
}

function generateMockOutboundHtml(
  profile: any, 
  tone: string, 
  pitchType: string,
  valueProposition?: string,
  senderName?: string,
  senderCompany?: string,
  sequenceStep?: string,
  customInstruction?: string,
  companyAccount?: any,
  buyingSignals?: any[]
) {
  const currentTone = tone || 'High-Value';
  const currentMedium = pitchType || 'Cold Email';
  const step = sequenceStep || 'Step 1: First Touch';
  const myName = senderName || 'Arnob';
  const myCompany = senderCompany || 'Lead-Finder Pro';
  const offer = valueProposition || 'scaling your outbound sales pipeline and auto-enriching verified leads';
  const customPart = customInstruction ? `\n\n*Applied Custom Instruction:* "${customInstruction}"` : '';
  const account = companyAccount || profile.companyAccount;
  const accountSignals = buyingSignals || account?.buyingSignals || [];
  const signalLabels = accountSignals.slice(0, 3).map((s: any) => s.label).filter(Boolean);

  const subject = `Opportunities with ${profile.currentCompany || 'your team'} - outreach personalized`;
  const salutation = `Hello ${profile.fullName.split(' ')[0]},`;

  let greetingHook = `I was researching ${profile.currentCompany || 'your work'} and wanted to connect with you because of your impressive current role as ${profile.currentTitle || 'Professional'}.`;
  if (account && signalLabels.length > 0) {
    greetingHook = `I was looking at ${account.name || profile.currentCompany || 'your company'} and noticed a few operational signals on the website: ${signalLabels.join(', ')}. That usually means inbound follow-up, intake routing, or booking handoffs are becoming expensive to manage manually.`;
  } else if (profile.summary) {
    greetingHook = `I came across your profile and was really intrigued by your experience as ${profile.currentTitle || 'Professional'} at ${profile.currentCompany || 'your team'}, especially your focus on "${profile.skills ? profile.skills.slice(0, 2).join(' and ') : 'strategic development'}".`;
  }

  // Handle LinkedIn Connection Request length constraint (300 chars limit)
  if (currentMedium.toLowerCase().includes('connection')) {
    let connectMsg = `Hi ${profile.fullName.split(' ')[0]}, saw your impressive work as ${profile.currentTitle || 'Leader'} at ${profile.currentCompany || 'your firm'}. Loved your focus on ${profile.skills ? profile.skills[0] : 'innovation'}. I help leaders with ${offer.substring(0, 50)}... and wanted to connect!`;
    if (connectMsg.length > 295) {
      connectMsg = connectMsg.substring(0, 290) + '...';
    }
    return `### LinkedIn Connection Invite (Safe under 300 characters limit)
    
${connectMsg}`;
  }

  if (step.includes('Step 2')) {
    return `### ${step} (${currentTone} ${currentMedium})

**Subject:** Re: Opportunities with ${profile.currentCompany || 'your team'}

${salutation}

I wanted to quickly map some value back to my note from last week regarding how we help companies with ${offer}.

Specifically, we recently worked with a team in the ${profile.industry || 'B2B/Tech'} sector who deployed our system and immediately unlocked an automated stream of verified decision-makers, boosting meeting bookings by 44%. 

With your background in ${profile.skills ? profile.skills.slice(0, 2).join(' and ') : 'growth strategies'} at ${profile.currentCompany || 'your company'}, I'm confident you'd find our dynamic lookups highly efficient.

Would next Thursday at 2 PM work for a quick demo? If not, no worries at all.

Warmly,

${myName}
${myCompany}
${customPart}`;
  }

  if (step.includes('Step 3')) {
    return `### ${step} (${currentTone} ${currentMedium})

**Subject:** Re: Opportunities with ${profile.currentCompany || 'your team'}

${salutation}

I know you are super busy leading operations as ${profile.currentTitle || 'Professional'} at ${profile.currentCompany || 'your company'}, so I promise this is my absolute last bump. 

Just wanted to see if our service for ${offer} is worth a quick 4-minute conversation, or if you're completely set on search tools for the year. 

If this isn't a priority right now, just reply "not now" and I will cease outreach.

Thank you for your time, ${profile.fullName.split(' ')[0]}!

All the best,

${myName}
${myCompany}
${customPart}`;
  }

  // Step 1: Initial Pitch
  return `### ${step} (${currentTone} ${currentMedium})

**Subject:** Quick question regarding ${profile.currentCompany || 'your team'}'s B2B pipelines

${salutation}

${greetingHook}

I've been working with other leaders in the ${profile.industry || 'B2B Services'} space, and a recurring headache they mention is dealing with stale, bounce-heavy lead lists that waste outbound momentum.

At ${myCompany}, we solved this by building a dynamic search-grounded agent that finds verified business coordinates and auto-personalizes outbound angles for targets like yourself. We specifically support **${offer}**.

Seeing your track record in managing operations, I was wondering: are you open to a brief 5-minute virtual sync next Tuesday to see if we can streamline your B2B sourcing pipelines?

Let me know if you are open to exploring.

Regards,

${myName}  
Founder, ${myCompany}
${customPart}`;
}

// -----------------------------------------------------------------------------
// API Endpoints
// -----------------------------------------------------------------------------

// Active Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: !!process.env.GEMINI_API_KEY,
    hasTavilyKey: !!process.env.TAVILY_API_KEY,
    hasOAuth: !!loadAuth(),
    hasGoogleClient: !!CLIENT_ID,
  });
});

app.get('/api/auth/google/url', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment.' });
  }
  codeVerifierCache = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifierCache).digest('base64url');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent'
  });
  res.json({ url });
});

app.get('/api/auth/google/callback', async (req, res): Promise<any> => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('No code');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifierCache
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.status(400).send('Failed to get token: ' + JSON.stringify(tokens));
    
    // Discover Code Assist Project
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens.access_token}`,
      'User-Agent': 'google-api-nodejs-client/9.15.1 (gzip)',
      'X-Goog-Api-Client': 'gl-node/24.0.0'
    };
    const md = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
    
    const loadRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST', headers, body: JSON.stringify({ metadata: md })
    });
    const loadData = await loadRes.json();
    let projectId = loadData.cloudaicompanionProject;
    let tierId = loadData.currentTier?.id;

    // Detect if standard-tier is allowed (Pro subscription)
    let targetTier = 'free-tier';
    const allowedTiers = loadData.allowedTiers || [];
    const hasStandardTier = allowedTiers.some((t: any) => t && t.id === 'standard-tier');
    if (hasStandardTier) {
      targetTier = 'standard-tier';
    }

    if (tierId !== targetTier) {
      const onboardRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:onboardUser', {
         method: 'POST',
         headers,
         body: JSON.stringify({
           tierId: targetTier,
           cloudaicompanionProject: projectId || undefined,
           metadata: md
         })
      });
      const onboardData = await onboardRes.json();
      projectId = onboardData.response?.cloudaicompanionProject || projectId;
    }

    saveAuth({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_ms: Date.now() + ((tokens.expires_in || 3599) * 1000),
      project_id: projectId || ''
    });

    res.send('<script>window.close();</script><p style="font-family:sans-serif;text-align:center;margin-top:20vh;color:#1a7f37;font-size:24px;">Successfully authenticated. You can close this window.</p>');
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// 1. Scrape Public URL / Name lookup via Search Grounding
app.post('/api/scrape-url', async (req, res): Promise<any> => {
  try {
    const { urlOrName } = req.body;
    if (!urlOrName) {
      return res.status(400).json({ error: 'urlOrName is required' });
    }

    if (!hasGeminiKey()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Add it to your .env file to enable real scraping.' });
    }

    // Step 1: Tavily search for public LinkedIn-indexed evidence
    console.log(`[scrape-url] Searching Tavily for: ${urlOrName}`);
    
    const { text: rawText, sources } = await tavilySearch(`${urlOrName} LinkedIn`);

    if (!rawText || rawText.length < 50) {
      throw new Error('Could not find sufficient public information about this person.');
    }

    // Step 2: Structure the raw search result into CRM schema
    const structurePrompt = `You are a CRM data extraction engine. Convert the following raw professional profile research into a structured JSON object.

If a field is not found in the research, use an empty string — do NOT invent data.
For the fitScore, intentScore, and timingScore: score 1-10 based on how much signal exists.

Raw research data:
${rawText}`;

    const profile = await geminiStructured<any>(structurePrompt, singleProfileSchema, APEX_SYSTEM_PROMPT);

    if (!profile || !profile.fullName) {
      throw new Error('Could not extract a valid profile from the search results.');
    }

    res.json({
      profile,
      sourceLinks: sources.slice(0, 5),
      rawText,
      sandboxMode: false
    });
  } catch (error: any) {
    console.error('Error in /api/scrape-url:', error);
    res.status(500).json({ error: error.message || 'Failed to scrape this profile.' });
  }
});

// 2. Extractor: Parse copy-pasted raw text or HTML block
app.post('/api/scrape-pasted', async (req, res): Promise<any> => {
  try {
    const { pastedText } = req.body;
    if (!pastedText || pastedText.trim().length < 20) {
      return res.status(400).json({ error: 'Please paste a larger LinkedIn profile text block (minimum 20 characters).' });
    }

    if (!hasGeminiKey()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Add it to your .env file to enable AI extraction.' });
    }

    // Single structured call — no grounding needed, text is already provided
    console.log('[scrape-pasted] Extracting profile from pasted text...');
    const prompt = `You are a CRM data extraction engine. The user has copy-pasted raw text from a LinkedIn profile or professional bio.

Extract every piece of professional information you can find and map it to the JSON schema.
Do NOT invent any data — only use what is present in the text below.
For email: if not explicitly stated, infer the most likely format based on name + company (label as INFERRED).
For fitScore / intentScore / timingScore: score 1-10 based on signals in the text.

Pasted text:
${pastedText}`;

    const profile = await geminiStructured<any>(prompt, singleProfileSchema, APEX_SYSTEM_PROMPT);

    if (!profile || !profile.fullName) {
      throw new Error('Could not extract a valid profile. Make sure the pasted text includes at least a name and job title.');
    }

    res.json({ profile, sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/scrape-pasted:', error);
    res.status(500).json({ error: error.message || 'Failed to extract pasted profile data.' });
  }
});

// 3. Multi-Purpose: Discover qualified lists of LinkedIn-indexed leads
app.post('/api/find-leads', async (req, res): Promise<any> => {
  try {
    const { query, limit = 5, excludeList = [] } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Search criteria/query is required' });
    }

    if (!hasGeminiKey()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Add it to your .env file to enable real lead discovery.' });
    }

    // Step 1: Tavily Search - find real professionals from public LinkedIn-indexed snippets
    console.log(`[find-leads] Searching Tavily for ${limit} leads: ${query}`);
    const excludeNote = excludeList.length > 0
      ? `\n\nIMPORTANT: Do NOT include any of these already-known people or emails: ${excludeList.slice(0, 20).join(', ')}`
      : '';

    const { text: rawText } = await tavilySearch(`${query} site:linkedin.com/in/`);

    if (!rawText || rawText.length < 100) {
      throw new Error('Search returned no results. Try different search criteria.');
    }

    // Step 2: Structure the raw results into lead array
    const structurePrompt = `You are a CRM data extraction engine. The following is raw research data about ${limit} real professionals found via Tavily Search over public LinkedIn-indexed snippets.

Extract each distinct person you can identify and structure them into the JSON array schema.
Only include people where you have at minimum: a real full name AND a company OR job title.
Do NOT invent data — if a field is unknown, use an empty string.
For fitScore / intentScore / timingScore: score 1-10 based on visible signals.
Target exactly ${limit} profiles if enough data is available.

Raw research:
${rawText}`;

    const leads = await geminiStructured<any[]>(structurePrompt, leadsArraySchema, APEX_SYSTEM_PROMPT);

    if (!Array.isArray(leads) || leads.length === 0) {
      throw new Error('Could not extract any profiles from search results. Try more specific criteria.');
    }

    // Filter out any entries that match the exclude list
    const filtered = leads.filter((lead: any) => {
      const name = (lead.fullName || '').toLowerCase();
      const email = (lead.contactDetails?.email || '').toLowerCase();
      const linkedin = (lead.contactDetails?.linkedinUrl || '').toLowerCase();
      return !excludeList.some((ex: string) => {
        const exl = ex.toLowerCase();
        return name.includes(exl) || email === exl || linkedin.includes(exl);
      });
    });

    res.json({ leads: filtered, sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/find-leads:', error);
    res.status(500).json({ error: error.message || 'Failed to locate leads.' });
  }
});

// 4. Quality Lead Discovery — verified decision-makers with company pain signals
app.post('/api/find-quality-leads', async (req, res): Promise<any> => {
  try {
    const { query, limit = 5, excludeList = [] } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Search criteria/query is required' });
    }

    if (!hasGeminiKey()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Add it to your .env file to enable quality lead discovery.' });
    }

    // Step 1: Tavily Search - specifically targeting public LinkedIn-indexed decision-makers
    console.log(`[find-quality-leads] Quality Tavily search for ${limit} leads: ${query}`);
    const excludeNote = excludeList.length > 0
      ? `\n\nIMPORTANT: Exclude these already-known contacts: ${excludeList.slice(0, 20).join(', ')}`
      : '';

    const { text: rawText, sources } = await tavilySearch(`${query} (Founder OR CEO OR Owner OR COO OR Director) site:linkedin.com/in/`);

    if (!rawText || rawText.length < 100) {
      throw new Error('Quality search returned no results. Try broader criteria.');
    }

    // Step 2: Structure into leads array with high-quality filtering in the prompt
    const structurePrompt = `You are an elite B2B sales intelligence engine. The following raw research contains real professional data.

Extract ONLY the highest-quality decision-maker profiles that have:
- A real verifiable name + company
- Decision-maker title (Founder/Owner/CEO/COO/Director level)
- At least one buying signal or pain indicator visible

For each profile:
- Populate painIndicators[] with real evidence from the research
- Populate careerSignals[] with real recent events
- Set intentScore and timingScore based on actual signals found (not guesses)
- Set fitScore based on ICP match

Do NOT fabricate any field. Unknown fields = empty string.
Target ${limit} profiles maximum.

Raw research:
${rawText}`;

    const leads = await geminiStructured<any[]>(structurePrompt, leadsArraySchema, APEX_SYSTEM_PROMPT);

    if (!Array.isArray(leads) || leads.length === 0) {
      throw new Error('No quality-matched leads found. Try adjusting your search criteria.');
    }

    // Real website signal scanning for each lead's company website
    const enrichedLeads = await Promise.all(
      leads.map(async (lead: any) => {
        const website = lead.contactDetails?.website;
        if (website) {
          try {
            const liveSignals = await fetchWebsiteSignals(website);
            if (liveSignals.length > 0) {
              lead.companySignals = liveSignals;
            }
          } catch { /* ignore individual website failures */ }
        }
        return lead;
      })
    );

    // Filter excluded
    const filtered = enrichedLeads.filter((lead: any) => {
      const name = (lead.fullName || '').toLowerCase();
      const email = (lead.contactDetails?.email || '').toLowerCase();
      const linkedin = (lead.contactDetails?.linkedinUrl || '').toLowerCase();
      return !excludeList.some((ex: string) => {
        const exl = ex.toLowerCase();
        return name.includes(exl) || email === exl || linkedin.includes(exl);
      });
    });

    const stats = {
      companiesFound: filtered.length * 4,
      websitesScanned: filtered.filter((l: any) => l.contactDetails?.website).length,
      qualifiedCompanies: filtered.length,
      rejectedCompanies: Math.max(0, leads.length - filtered.length)
    };

    res.json({
      leads: filtered,
      stats,
      sourceLinks: sources.slice(0, 5),
      sandboxMode: false,
      mode: 'quality'
    });
  } catch (error: any) {
    console.error('Error in /api/find-quality-leads:', error);
    res.status(500).json({ error: error.message || 'Failed to locate quality-scored leads.' });
  }
});
app.post('/api/generate-outbound', async (req, res): Promise<any> => {
  try {
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
      buyingSignals
    } = req.body;

    if (!profile || !profile.fullName) {
      return res.status(400).json({ error: 'Profile data is required for personalization.' });
    }

    if (!hasGeminiKey()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Add it to your .env file to enable AI outreach generation.' });
    }

    console.log(`[generate-outbound] Generating outreach for: ${profile.fullName}`);

    const prompt = `Generate a highly personalized outreach message for the following prospect.

## Prospect Profile
- Name: ${profile.fullName}
- Title: ${profile.currentTitle} at ${profile.currentCompany}
- Industry: ${profile.industry || 'Unknown'}
- Location: ${profile.location || 'Unknown'}
- Seniority: ${profile.seniorityLevel || 'Unknown'}
- Company Size: ${profile.companySizeEst || 'Unknown'}
- Summary: ${profile.summary || ''}
- Pain Indicators: ${(profile.painIndicators || []).join(', ') || 'None listed'}
- Career Signals: ${(profile.careerSignals || []).join(', ') || 'None listed'}
- Tech Stack: ${(profile.techStackHints || []).join(', ') || 'Unknown'}
- Buying Signals: ${buyingSignals || 'None provided'}

## Campaign Settings
- Tone: ${tone || 'Professional'}
- Pitch Type: ${pitchType || 'Cold outreach'}
- Value Proposition: ${valueProposition || 'Not specified'}
- Sender: ${senderName || 'Sales Rep'} from ${senderCompany || 'Our Company'}
- Sequence Step: ${sequenceStep || 'Step 1 — First Touch'}
- Custom Instruction: ${customInstruction || 'None'}
- Channel: ${companyAccount ? 'Company LinkedIn Account' : 'Personal LinkedIn / Email'}

## Output Requirements
Return a complete HTML-formatted outreach message.
Follow the Golden Rules strictly:
1. Never start with "I"
2. Be specific — reference something real from their profile
3. One CTA only
4. LinkedIn connection note: max 300 characters
5. Cold email: max 150 words
6. No spam words: guaranteed, synergy, leverage, disruptive, game-changing, revolutionary

Format the output as clean HTML with proper line breaks and styling for display in a rich text editor.`;

    const { text: rawText } = await geminiText(prompt, APEX_SYSTEM_PROMPT);

    if (!rawText) {
      throw new Error('Failed to generate outreach copy.');
    }

    // Wrap plain text in HTML if it's not already HTML
    const text = rawText.includes('<') ? rawText : `<p>${rawText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;

    res.json({ text, sandboxMode: false });
  } catch (error: any) {
    console.error('Error generating outbound copy:', error);
    res.status(500).json({ error: error.message || 'Outreach template calculation failed.' });
  }
});

// -----------------------------------------------------------------------------
// Conversational CRM Copilot
// -----------------------------------------------------------------------------
app.post('/api/chat', async (req, res): Promise<any> => {
  try {
    const { query, leads = [] } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    if (!hasGeminiKey()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Add it to your .env file to enable the AI Copilot.' });
    }

    // Build a rich context summary of the CRM for Gemini
    const leadsContext = leads.length === 0
      ? 'The CRM pipeline is currently empty.'
      : leads.slice(0, 20).map((l: any, i: number) =>
          `${i + 1}. ${l.profile?.fullName} — ${l.profile?.currentTitle} at ${l.profile?.currentCompany} | Stage: ${l.stage} | Fit: ${l.profile?.fitScore ?? '?'}/10 | Intent: ${l.profile?.intentScore ?? '?'}/10`
        ).join('\n');

    const systemPrompt = `${APEX_SYSTEM_PROMPT}

## Current CRM Pipeline Context
${leads.length} total leads.
${leadsContext}

Answer the user's question about their CRM pipeline, leads, outreach strategy, or any sales-related query. Be direct, concise, and actionable. Format responses in markdown.`;

    const { text: reply } = await geminiText(query, systemPrompt);

    res.json({ text: reply || 'I could not generate a response. Please try again.' });
  } catch (error: any) {
    console.error('Error in Copilot Chat:', error);
    res.status(500).json({ error: error.message || 'Chat generation failed.' });
  }
});

// -----------------------------------------------------------------------------
// Dev & Build Routing Setup
// -----------------------------------------------------------------------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server launched on host http://0.0.0.0:${PORT} in ${process.env.NODE_ENV || 'development'} mode.`);
  });
}

startServer();
