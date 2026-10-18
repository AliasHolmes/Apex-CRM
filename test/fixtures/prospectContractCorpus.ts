/**
 * Prospect contract corpus regression fixtures.
 *
 * Source: 33 historical rows of prospect_contract_cache (policy versions v8-v10,
 * collected 2026-09-07 through 2026-10-16). The corpus is the real-world
 * documentation of the contract compiler's behavior:
 *
 * - Cases WITHOUT "issues" compiled correctly and are pinned so the metro-aware
 *   funnels keep working for them: location requirements stay geo-anchored to the
 *   brief's named places, company types stay noun-y, no city leaks into company_type.
 * - Cases WITH "issues" are the historical corruptions this remediation fixes;
 *   "corruptSourcePhrases" are the exact inverted/impossible values the v8-v10
 *   funnels produced (extracted from the live SQLite cache on 2026-10-17) and must
 *   never recur. "manual-pinned" lists values the auto-classifier under-caught but
 *   the forensic audit of session c0a2c8b7 confirmed as corrupt.
 */
export type ProspectContractCorpusCase = {
  /** Historical prospect_contract_cache rowid. */
  id: number;
  /** Verbatim raw brief stored with the historical contract. */
  brief: string;
  /** Historical corruption markers derived from the cached contract row. */
  issues: string[];
  /** Exact corrupt requirement values produced historically (must never recur). */
  corruptSourcePhrases: string[];
  /** Geo entities named in the brief; a captured person_location must include them. */
  mustIncludeLocations?: string[];
};

export const PROSPECT_CONTRACT_CORPUS: ProspectContractCorpusCase[] = [
  {
    "id": 3,
    "brief": "AI marketing agency owner from the USA",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 4,
    "brief": "Agency owners selling AI automation who lack technical developers.",
    "issues": [],
    "corruptSourcePhrases": []
  },
  {
    "id": 1,
    "brief": "test query agency prospecting",
    "issues": [],
    "corruptSourcePhrases": []
  },
  {
    "id": 5,
    "brief": "AI business owner, AI service provider and AI agency owner from UK",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "uk"
    ]
  },
  {
    "id": 6,
    "brief": "AI business owner, AI service provider and AI agency owner from Australia",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "australia"
    ]
  },
  {
    "id": 7,
    "brief": "AI business owner, AI service provider, AI agency owner",
    "issues": [],
    "corruptSourcePhrases": []
  },
  {
    "id": 8,
    "brief": "AI marketing agency owner from USA",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 9,
    "brief": "AI firm and agency owner from USA with hiring intent",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 10,
    "brief": "AI firm and agency owner from USA/UK/Australia/Canada/NewZealand with hiring intent",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa",
      "uk",
      "australia",
      "canada",
      "newzealand"
    ]
  },
  {
    "id": 11,
    "brief": "Founders of 3 to 12 person B2B outbound lead generation agencies in the US or UK who use Clay, Instantly, or Smartlead and talk about high task costs or broken Zapier workflows",
    "issues": [
      "junk-clause-company-type",
      "tooling-as-company-type"
    ],
    "corruptSourcePhrases": [
      "UK who use Clay",
      "Instantly",
      "Smartlead",
      "talk about high task costs"
    ],
    "mustIncludeLocations": [
      "us",
      "uk"
    ]
  },
  {
    "id": 12,
    "brief": "Agency owners in North America actively posting on LinkedIn about client delivery bottlenecks or needing an extra hand to build custom n8n workflows and API integrations",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "america"
    ]
  },
  {
    "id": 13,
    "brief": "AI automation agency founders and owners from australia with hiring intent",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "australia"
    ]
  },
  {
    "id": 14,
    "brief": "AI automation agency founders and owners from Canada with hiring intent",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "canada"
    ]
  },
  {
    "id": 15,
    "brief": "AI automation agency founders and owners from Ireland with hiring intent",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "ireland"
    ]
  },
  {
    "id": 17,
    "brief": "Founders of digital agencies in Canada or Australia interested in self-hosting n8n or building custom Python backends to replace expensive multi-step Zapier subscriptions",
    "issues": [
      "location-not-geo",
      "junk-clause-company-type"
    ],
    "corruptSourcePhrases": [
      "self-hosting n8n",
      "Australia interested"
    ],
    "mustIncludeLocations": [
      "canada",
      "australia"
    ]
  },
  {
    "id": 18,
    "brief": "AI service provider agency owner in Canada and USA",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "canada",
      "usa"
    ]
  },
  {
    "id": 19,
    "brief": "AI service provider firm and agency owner from USA and Canada",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa",
      "canada"
    ]
  },
  {
    "id": 20,
    "brief": "AI service provider firm and agency owner from New Zealand",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "new zealand"
    ]
  },
  {
    "id": 21,
    "brief": "AI service provider firm and agency owner from Australia",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "australia"
    ]
  },
  {
    "id": 22,
    "brief": "AI service provider firm and agency owner from England",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "england"
    ]
  },
  {
    "id": 23,
    "brief": "AI pioneer agency founder and researcher in USA",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 24,
    "brief": "AI service agency owner and founder in USA",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 25,
    "brief": "AI digital service provider firm and agency owner in USA, Canada",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa",
      "canada"
    ]
  },
  {
    "id": 26,
    "brief": "AI agency and firm owners from the USA who provide services to local small and medium-sized businesses",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 27,
    "brief": "AI agency and firm owners from the USA who provide services to local small and medium-sized businesses that have hiring intent",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 28,
    "brief": "AI related service firm owners from USA",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "usa"
    ]
  },
  {
    "id": 29,
    "brief": "AI service firm owners in Texas, New York, San Francisco, and Florida",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "new york",
      "san francisco",
      "texas",
      "florida"
    ]
  },
  {
    "id": 30,
    "brief": "AI and automation consulting firm partners and owners in Chicago, Boston, Atlanta, and Washington DC",
    "issues": [],
    "corruptSourcePhrases": [],
    "mustIncludeLocations": [
      "chicago",
      "boston",
      "atlanta",
      "washington"
    ]
  },
  {
    "id": 31,
    "brief": "CTO, VP of Engineering, or Head of Data at companies with 50-250 employees in the US or Canada using Snowflake, Databricks, or looking to adopt generative AI",
    "issues": [
      "role-leak-company-type",
      "junk-clause-company-type",
      "manual-pinned"
    ],
    "corruptSourcePhrases": [
      "CTO",
      "looking to adopt generative AI",
      "Data at companies"
    ],
    "mustIncludeLocations": [
      "us",
      "canada"
    ]
  },
  {
    "id": 32,
    "brief": "Founders or Operations Leads at B2B cold email agencies with 3-15 team members in North America who manage 50+ client domains and talk about Google/Outlook deliverability or inbox management",
    "issues": [
      "junk-clause-company-type"
    ],
    "corruptSourcePhrases": [
      "talk about Google/Outlook deliverability"
    ],
    "mustIncludeLocations": [
      "america"
    ]
  },
  {
    "id": 16,
    "brief": "CEOs and Owners of boutique B2B outbound lead generation agencies with 2 to 12 employees in the United States or UK who use Clay, Instantly, or Smartlead and complain about high tool costs or broken Zapier tasks",
    "issues": [
      "junk-clause-company-type",
      "tooling-as-company-type"
    ],
    "corruptSourcePhrases": [
      "UK who use Clay",
      "broken Zapier tasks"
    ],
    "mustIncludeLocations": [
      "uk",
      "united states"
    ]
  },
  {
    "id": 33,
    "brief": "Founders, CEOs, and Managing Partners of boutique B2B outbound and demand generation agencies with 4 to 20 employees in Austin, Denver, Toronto, and Salt Lake City specializing in outbound pipeline, Clay data enrichment, or cold email infrastructure",
    "issues": [
      "location-not-geo",
      "metro-in-company-type"
    ],
    "corruptSourcePhrases": [
      "outbound pipeline",
      "Clay data enrichment",
      "cold email infrastructure",
      "Salt Lake City specializing"
    ],
    "mustIncludeLocations": [
      "austin",
      "denver",
      "toronto",
      "salt lake city"
    ]
  },
  {
    "id": 34,
    "brief": "40 US AI agency owners actively recruiting talent",
    "issues": [
      "digit-prefixed-company-type"
    ],
    "corruptSourcePhrases": [
      "40 US AI agency"
    ]
  }
];
