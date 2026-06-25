import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import { getMcpClient } from '../services/mcp.js';
import { readStoredLeads, hasLeadStoreBeenInitialized, replaceStoredLeads, normalizeIncomingLeads, getLeadsDb, insertSearchLog } from '../db.js';
import { loadAuth, saveAuth } from '../auth.js';
import { hasOpenAIKey, tavilySearch, openAIStructured, singleProfileSchema, APEX_SYSTEM_PROMPT, leadsArraySchema, searchQueriesSchema, openAIText } from '../services/llm.js';

const router = Router();
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.APP_URL ? (process.env.APP_URL + '/api/auth/google/callback') : 'http://localhost:3000/api/auth/google/callback';
let codeVerifierCache = '';

router.post('/mcp/linkedin', async (req, res): Promise<any> => {
  if (!getMcpClient()) {
    return res.status(503).json({ error: 'LinkedIn MCP client is not initialized.' });
  }
  try {
    const { toolName, args } = req.body;
    if (!toolName) {
      return res.status(400).json({ error: 'toolName is required.' });
    }
    const result = await getMcpClient().callTool({
      name: toolName,
      arguments: args || {}
    });
    res.json(result);
  } catch (error: any) {
    console.error(`[MCP] Tool call failed:`, error);
    res.status(500).json({ error: error.message || 'Failed to call MCP tool.' });
  }
});

router.get('/leads', (req, res): any => {
  try {
    res.json({ leads: readStoredLeads(), initialized: hasLeadStoreBeenInitialized() });
  } catch (error: any) {
    console.error('Failed to read leads from SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to read leads' });
  }
});

router.put('/leads', (req, res): any => {
  try {
    const leads = normalizeIncomingLeads(req.body?.leads);
    if (!leads) {
      return res.status(400).json({ error: 'Expected a leads array.' });
    }

    replaceStoredLeads(leads);
    res.json({ success: true, count: leads.length });
  } catch (error: any) {
    console.error('Failed to persist leads to SQLite:', error);
    res.status(500).json({ error: error.message || 'Failed to persist leads' });
  }
});
// Active Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: !!process.env.OPENAI_API_KEY,
    hasTavilyKey: !!process.env.TAVILY_API_KEY,
    hasOAuth: !!loadAuth(),
    hasGoogleClient: !!CLIENT_ID,
  });
});

router.get('/auth/google/url', (req, res) => {
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

router.get('/auth/google/callback', async (req, res): Promise<any> => {
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
    const md = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "OPENAI" };
    
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
router.post('/scrape-url', async (req, res): Promise<any> => {
  try {
    const { urlOrName } = req.body;
    if (!urlOrName) {
      return res.status(400).json({ error: 'urlOrName is required' });
    }

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable real scraping.' });
    }

    // Step 1: Tavily search for public LinkedIn-indexed evidence
    console.log(`[scrape-url] Searching Tavily for: ${urlOrName}`);
    
    const { text: rawText, sources } = await tavilySearch(`${urlOrName} LinkedIn`);

    if (!rawText || rawText.length < 50) {
      throw new Error('Could not find sufficient public information about this person.');
    }

    // Step 2: Structure the raw search result into CRM schema
    const structurePrompt = `You are a CRM data extraction engine. Convert the following raw professional profile research into a structured JSON object.

If a field is not found in the research, use an empty string â€” do NOT invent data.
For the fitScore, intentScore, and timingScore: score 1-10 based on how much signal exists.

Raw research data:
${rawText}`;

    const profile = await openAIStructured<any>(structurePrompt, singleProfileSchema, APEX_SYSTEM_PROMPT);

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
router.post('/scrape-pasted', async (req, res): Promise<any> => {
  try {
    const { pastedText } = req.body;
    if (!pastedText || pastedText.trim().length < 20) {
      return res.status(400).json({ error: 'Please paste a larger LinkedIn profile text block (minimum 20 characters).' });
    }

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable AI extraction.' });
    }

    // Single structured call â€” no grounding needed, text is already provided
    console.log('[scrape-pasted] Extracting profile from pasted text...');
    const prompt = `You are a CRM data extraction engine. The user has copy-pasted raw text from a LinkedIn profile or professional bio.

Extract every piece of professional information you can find and map it to the JSON schema.
Do NOT invent any data â€” only use what is present in the text below.
For email: if not explicitly stated, infer the most likely format based on name + company (label as INFERRED).
For fitScore / intentScore / timingScore: score 1-10 based on signals in the text.

Pasted text:
${pastedText}`;

    const profile = await openAIStructured<any>(prompt, singleProfileSchema, APEX_SYSTEM_PROMPT);

    if (!profile || !profile.fullName) {
      throw new Error('Could not extract a valid profile. Make sure the pasted text includes at least a name and job title.');
    }

    res.json({ profile, sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/scrape-pasted:', error);
    res.status(500).json({ error: error.message || 'Failed to extract pasted profile data.' });
  }
});

// -----------------------------------------------------------------------------
// Search Logging Utility
// -----------------------------------------------------------------------------


router.get('/search-logs', (req, res): any => {
  try {
    const db = getLeadsDb();
    const stmt = db.prepare('SELECT * FROM search_logs ORDER BY timestamp DESC');
    const rows = stmt.all() as any[];
    
    const logs = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      prompt: r.prompt,
      generatedQueries: JSON.parse(r.generated_queries || '[]'),
      status: r.status,
      errorMessage: r.error_message,
      rawResultsCount: r.raw_results_count,
      leadsFound: r.leads_found,
      detailedLogs: r.detailed_logs
    }));
    res.json(logs);
  } catch (error: any) {
    console.error('Failed to read search logs:', error);
    res.status(500).json({ error: 'Failed to retrieve search logs.' });
  }
});

// 3. Multi-Purpose: Discover qualified lists of LinkedIn-indexed leads
router.post('/find-leads', async (req, res): Promise<any> => {
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const sessionLogs: string[] = [];
  const logEvent = (msg: string) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); sessionLogs.push(line); };
  logEvent(`--- NEW ADAPTIVE MINING SESSION: ${sessionId} ---`);
  let generatedQueries: string[] = [];
  let rawResultsCount = 0;
  let leadsFound = 0;
  const promptQuery = req.body.query || '';

  try {
    const { query, limit = 5, excludeList = [] } = req.body;
    if (!query) {
      throw new Error('Search criteria/query is required');
    }

    if (!hasOpenAIKey()) {
      throw new Error('OPENAI_API_KEY is not configured. Add it to your .env file to enable real lead discovery.');
    }

    // Step 1: The Search Strategist - Generate optimized boolean search queries
    console.log(`[find-leads] Generating search queries for: ${query}`);
    const excludeNote = excludeList.length > 0
      ? `\n\nIMPORTANT: Do NOT include any of these already-known people or emails in your search keywords: ${excludeList.slice(0, 20).join(', ')}`
      : '';

    const strategistPrompt = `You are an expert search strategist. The user is looking for leads matching the following description:
"${query}"

Your task is to generate exactly 3 highly targeted search queries to find these specific profiles. 
RULES:
1. Tavily Search does NOT support complex Google Dorks or boolean operators (AND, OR, parentheses). Do NOT use them.
2. Generate simple, natural language keyword strings (e.g. "Founder Marketing Agency New York").
3. DO NOT use the word "linkedin" or the "site:" operator. Just provide the raw keywords.
4. Keep the 3 queries distinct from each other to cast a wide but highly relevant net.
${excludeNote}
`;

    const { queries } = await openAIStructured<{ queries: string[] }>(strategistPrompt, searchQueriesSchema, APEX_SYSTEM_PROMPT);

    if (!queries || queries.length === 0) {
      throw new Error('Failed to generate search queries. Try simplifying your prompt.');
    }

    // Programmatically prepend the site operator to prevent LLM formatting errors
    generatedQueries = queries.map(q => {
      const cleanQ = q.replace(/site:linkedin\.com\/in\//gi, '').replace(/linkedin/gi, '').trim();
      return `site:linkedin.com/in/ ${cleanQ}`;
    });

    console.log(`[find-leads] Executing parallel searches for queries:`, generatedQueries);

    // Step 2: Execute Parallel Searches and Deduplicate
    const searchPromises = generatedQueries.map(q => tavilySearch(q).catch(e => {
      logEvent(`WARN: Search failed for query "${q}": ` + (e.message));
      return { text: '', sources: [], items: [] };
    }));
    
    const searchResults = await Promise.all(searchPromises);

    // Step 2.5: Deduplication & Deep Enrichment via LinkedIn MCP
    const uniqueUsernames = new Set<string>();
    const rawItems: any[] = [];

    for (const result of searchResults) {
      if (result.items && Array.isArray(result.items)) {
        for (const item of result.items) {
          const url = item.url || '';
          if (url) {
            const match = url.match(/linkedin\.com\/in\/([^\/?]+)/i);
            const username = match && match[1] ? match[1].toLowerCase() : url;
            if (!uniqueUsernames.has(username)) {
              uniqueUsernames.add(username);
              item._extractedUsername = match && match[1] ? match[1] : null;
              rawItems.push(item);
            }
          }
        }
      }
    }

    rawResultsCount = rawItems.length;

    if (rawResultsCount === 0) {
      throw new Error('All searches returned no results. Try different search criteria.');
    }

    console.log(`[find-leads] Found ${rawResultsCount} unique raw results.`);

    const maxEnrichments = Math.max(limit * 2, 10);
    let enrichmentCount = 0;

    let mcpHung = false;
    let consecutiveMcpFailures = 0;

    // Process deep enrichment sequentially to drastically reduce timeout errors
    const snippets: string[] = [];
    for (let index = 0; index < rawItems.length; index++) {
      const item = rawItems[index];
      const url = item.url || '';
      const title = item.title || 'Untitled result';
      const snippet = item.content || item.raw_content || '';
      
      let enrichedData = '';
      
      // Only enrich the first N results to prevent triggering anti-bot protections
      if (!mcpHung && getMcpClient() && url.includes('linkedin.com/in/') && index < maxEnrichments) {
        try {
          const match = url.match(/linkedin\.com\/in\/([^\/?]+)/i);
          if (match && match[1]) {
            const username = match[1];

            logEvent(`Deep enriching profile via MCP sequentially: ${username}`);
            
            // Promise.race to enforce a strict 15-second timeout since python MCP server might hang
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Local timeout: MCP server took too long (likely stuck on login wall)')), 15000)
            );
            
            const result = await Promise.race([
              getMcpClient().callTool({
                name: 'get_person_profile',
                arguments: {
                  linkedin_username: username,
                  sections: "experience,education,posts"
                }
              }),
              timeoutPromise
            ]) as any;
            
            if (result && result.content && result.content.length > 0) {
              enrichedData = result.content[0].text || '';
              enrichmentCount++;
              consecutiveMcpFailures = 0; // reset on success
            }
            
            // Jitter after each request to avoid rate limits
            const jitterMs = 1500 + Math.floor(Math.random() * 1000);
            logEvent(`Delaying next MCP fetch by ${jitterMs}ms (Anti-Bot Jitter)`);
            await new Promise(r => setTimeout(r, jitterMs));
          }
        } catch (error: any) {
          console.warn(`[find-leads] MCP deep enrichment failed for ${url}:`, error.message);
          consecutiveMcpFailures++;
          if (consecutiveMcpFailures >= 2) {
            console.warn(`[find-leads] MCP failed 2 times in a row. Likely blocked by an auth wall or captcha. Bypassing MCP to save time.`);
            logEvent(`MCP server seems blocked by Auth wall. Disabling MCP for the rest of this batch.`);
            mcpHung = true;
          }
        }
      }
      
      if (enrichedData) {
        snippets.push(`Title: ${title}\nLink: ${url}\n[NATIVE MCP PROFILE DATA]\n${enrichedData}\n\n`);
      } else {
        snippets.push(`Title: ${title}\nLink: ${url}\n[TAVILY SNIPPET]\n${snippet}\n\n`);
      }
    }

    console.log(`[find-leads] Deep enriched ${enrichmentCount} profiles via LinkedIn MCP.`);

    console.log(`[find-leads] Found ${rawResultsCount} unique raw results to extract leads from.`);

    // Step 3: Structure the raw results in dynamic token-aware parallel batches
    // Generating large JSON arrays from massive text prompts takes > 100s, triggering Cloudflare timeouts.
    // By chunking dynamically by character count, we avoid OOM and timeout errors gracefully.
    // Reduced to 6000 to prevent Cloudflare 524 timeouts.
    const MAX_CHUNK_LENGTH = 6000;
    const rawChunks: string[] = [];
    let currentChunk = '';
    
    for (let i = 0; i < snippets.length; i++) {
      const snippet = snippets[i];
      if (currentChunk.length + snippet.length > MAX_CHUNK_LENGTH && currentChunk.length > 0) {
        rawChunks.push(currentChunk);
        currentChunk = snippet;
      } else {
        currentChunk += snippet;
      }
    }
    if (currentChunk.length > 0) {
      rawChunks.push(currentChunk);
    }

    logEvent(`Chunked profiles into ${rawChunks.length} dynamic batches based on string length.`);

    const batchedPrompts = rawChunks.map(chunk => `You are a CRM data extraction engine. The following is raw research data about real professionals found via targeted LinkedIn searches.

Extract each distinct person you can identify and structure them into the JSON array schema.
Only include people where you have at minimum: a real full name AND a company OR job title.
Do NOT invent data â€” if a field is unknown, use an empty string.
For fitScore / intentScore / timingScore: score 1-10 based on visible signals.

Raw research:
${chunk}`);

    console.log(`[find-leads] Firing ${batchedPrompts.length} parallel extraction tasks...`);
    const extractionPromises = batchedPrompts.map(prompt => 
      openAIStructured<any[]>(prompt, leadsArraySchema, APEX_SYSTEM_PROMPT).catch(e => {
        console.warn('[find-leads] Extraction chunk failed:', e.message);
        return []; // If one chunk fails, don't crash the whole search
      })
    );

    const chunkedResults = await Promise.all(extractionPromises);
    let leads: any[] = [];
    for (const res of chunkedResults) {
      if (Array.isArray(res)) leads.push(...res);
    }

    if (leads.length === 0) {
      throw new Error('Could not extract any profiles from search results. Try more specific criteria.');
    }

    // Sort all extracted leads globally by score so we keep the absolute best ones
    leads.sort((a, b) => {
      const scoreA = a.predictiveScore || a.compositeScore || a.fitScore || 0;
      const scoreB = b.predictiveScore || b.compositeScore || b.fitScore || 0;
      return scoreB - scoreA;
    });

    // Trim down to the exact requested limit
    if (leads.length > limit) {
      leads = leads.slice(0, limit);
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

    leadsFound = filtered.length;

    const detailedLogsText = sessionLogs.join('\n');
    fs.appendFileSync('adaptive_mining_terminal.log', detailedLogsText + '\n\n');
    insertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: 'success',
      errorMessage: '',
      rawResultsCount,
      leadsFound,
      detailedLogs: detailedLogsText
    });

    res.json({ leads: filtered, sandboxMode: false });
  } catch (error: any) {
    console.error('Error in /api/find-leads:', error);
    
    const detailedLogsText = sessionLogs.join('\n');
    fs.appendFileSync('adaptive_mining_terminal.log', detailedLogsText + '\n\n');
    insertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: 'error',
      errorMessage: error.message || 'Failed to locate leads.',
      rawResultsCount,
      leadsFound: 0,
      detailedLogs: detailedLogsText
    });

    res.status(500).json({ error: error.message || 'Failed to locate leads.' });
  }
});

router.post('/generate-outbound', async (req, res): Promise<any> => {
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

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable AI outreach generation.' });
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
- Sequence Step: ${sequenceStep || 'Step 1 â€” First Touch'}
- Custom Instruction: ${customInstruction || 'None'}
- Channel: ${companyAccount ? 'Company LinkedIn Account' : 'Personal LinkedIn / Email'}

## Output Requirements
Return a complete HTML-formatted outreach message.
Follow the Golden Rules strictly:
1. Never start with "I"
2. Be specific â€” reference something real from their profile
3. One CTA only
4. LinkedIn connection note: max 300 characters
5. Cold email: max 150 words
6. No spam words: guaranteed, synergy, leverage, disruptive, game-changing, revolutionary

Format the output as clean HTML with proper line breaks and styling for display in a rich text editor.`;

    const { text: rawText } = await openAIText(prompt, APEX_SYSTEM_PROMPT);

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
router.post('/chat', async (req, res): Promise<any> => {
  try {
    const { query, leads = [] } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    if (!hasOpenAIKey()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Add it to your .env file to enable the AI Copilot.' });
    }

    // Build a rich context summary of the CRM for LLM
    const leadsContext = leads.length === 0
      ? 'The CRM pipeline is currently empty.'
      : leads.slice(0, 20).map((l: any, i: number) =>
          `${i + 1}. ${l.profile?.fullName} â€” ${l.profile?.currentTitle} at ${l.profile?.currentCompany} | Stage: ${l.stage} | Fit: ${l.profile?.fitScore ?? '?'}/10 | Intent: ${l.profile?.intentScore ?? '?'}/10`
        ).join('\n');

    const systemPrompt = `${APEX_SYSTEM_PROMPT}

## Current CRM Pipeline Context
${leads.length} total leads.
${leadsContext}

Answer the user's question about their CRM pipeline, leads, outreach strategy, or any sales-related query. Be direct, concise, and actionable. Format responses in markdown.`;

    const { text: reply } = await openAIText(query, systemPrompt);

    res.json({ text: reply || 'I could not generate a response. Please try again.' });
  } catch (error: any) {
    console.error('Error in Copilot Chat:', error);
    res.status(500).json({ error: error.message || 'Chat generation failed.' });
  }
});

export default router;
