export function generateMockLeads(query: string, limit: number, excludeList: string[] = []) {
  let location = "US Â· UK / Remote";
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
      headline: `${title} at ${companyName} | 5â€“75 Employees | Privately Held`,
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

export function generateMockSingleProfile(urlOrName: string) {
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

export function generateMockPastedProfile(pastedText: string) {
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

export function generateMockOutboundHtml(
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
