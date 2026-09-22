import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateMatchesNonServicesVertical,
  candidateMatchesWrongVertical,
  contractMentionsVertical,
  extractSocialProof,
  getWrongVerticalRegexForCluster,
  isCompanyPageProfile,
  isGhostProfile,
  parseSocialProofFromDossier,
  parseSocialProofFromText,
} from "../server/leadSearch/profileQuality.js";
import { checkStrictContradiction } from "../server/leadSearch/finalistJudge.js";
import {
  buildDeterministicProspectContract,
  normalizeProspectContract,
} from "../server/leadSearch/prospectContract.js";

test("social proof parsing", async (t) => {
  await t.test("reads dossier numeric fields, null when absent", () => {
    assert.deepEqual(parseSocialProofFromDossier({ followers: 31, connections: 28 }), {
      followers: 31,
      connections: 28,
      influencer: false,
    });
    assert.deepEqual(parseSocialProofFromDossier({}), {
      followers: null,
      connections: null,
      influencer: false,
    });
    assert.deepEqual(parseSocialProofFromDossier(null), {
      followers: null,
      connections: null,
      influencer: false,
    });
  });

  await t.test("parses snippet counts text", () => {
    const proof = parseSocialProofFromText(
      "# Paul Yau New York, US 500 connections, 1694 followers ## About",
    );
    assert.equal(proof.connections, 500);
    assert.equal(proof.followers, 1694);
  });

  await t.test("dossier wins over snippet text", () => {
    const lead = {
      _rawDossier: { followers: 31, connections: 28 },
      evidence: { evidenceBlock: "500 connections, 1694 followers" },
    };
    const proof = extractSocialProof(lead);
    assert.equal(proof.followers, 31);
    assert.equal(proof.connections, 28);
  });

  await t.test("ghost floor only fires on measured zeros", () => {
    assert.equal(isGhostProfile({ followers: 0, connections: 20, influencer: false }), true);
    assert.equal(isGhostProfile({ followers: 0, connections: null, influencer: false }), true);
    assert.equal(isGhostProfile({ followers: 31, connections: 28, influencer: false }), false);
    assert.equal(isGhostProfile({ followers: null, connections: null, influencer: false }), false);
    assert.equal(isGhostProfile({ followers: 0, connections: 500, influencer: false }), false);
  });
});

test("company-page-as-person detection", async (t) => {
  await t.test("flags identical person and company names", () => {
    assert.equal(
      isCompanyPageProfile({ fullName: "Verdeschi Realty", company: "Verdeschi Realty" }),
      true,
    );
  });

  await t.test("flags corporate names starting with articles or containing corporate nouns", () => {
    assert.equal(
      isCompanyPageProfile({ fullName: "The Agency", company: "The Agency (theagencyOnline.com)" }),
      true,
    );
    assert.equal(
      isCompanyPageProfile({ fullName: "Lucky Branded Entertainment", company: "Lucky Viral Branded Content" }),
      true,
    );
  });

  await t.test("passes real people, including eponymous firms", () => {
    assert.equal(
      isCompanyPageProfile({ fullName: "Marcia C. Brogan", company: "Marcia C. Brogan Agency LLC" }),
      false,
    );
    assert.equal(
      isCompanyPageProfile({ fullName: "Paul Yau", company: "The Travel Agency: A Cannabis Store" }),
      false,
    );
    assert.equal(
      isCompanyPageProfile({ fullName: "Dan Ratkewitch", company: "The Ratkewitch Agency" }),
      false,
    );
    assert.equal(
      isCompanyPageProfile({ fullName: "Shabbir Ahmad", company: "Tok Pros" }),
      false,
    );
    assert.equal(isCompanyPageProfile({}), false);
  });
});

test("wrong-vertical agency detection", async (t) => {
  await t.test("matches real estate, insurance, cannabis verticals", () => {
    assert.ok(candidateMatchesNonServicesVertical({ industry: "Cannabis Retail" }));
    assert.ok(
      candidateMatchesNonServicesVertical({
        currentCompany: "Verdeschi Realty",
        about: "independent real estate agency",
      }),
    );
    assert.ok(
      candidateMatchesNonServicesVertical({
        currentTitle: "Agency Owner - Allstate",
        currentCompany: "Allstate",
      }),
    );
    assert.ok(
      candidateMatchesNonServicesVertical({
        currentTitle: "Co-Founder/Broker - The Agency Texas",
        currentCompany: "The Agency Texas",
      }),
    );
    assert.ok(
      candidateMatchesNonServicesVertical({
        currentTitle: "AAA Entrepreneurial Agency Owner",
        currentCompany: "AAA Club Alliance",
      }),
    );
  });

  await t.test("passes digital agencies", () => {
    assert.equal(
      candidateMatchesNonServicesVertical({
        industry: "Marketing and Advertising",
        currentCompany: "Acme Digital",
        currentTitle: "Founder",
      }),
      null,
    );
  });

  await t.test("contract guard respects named verticals", () => {
    assert.equal(contractMentionsVertical("Find real estate agency owners"), true);
    assert.equal(contractMentionsVertical("Agency owners needing n8n help"), false);
  });
});

const agencyContract: any = {
  brief: "Agency owners in North America needing help with n8n workflows",
  authorityRequired: true,
  exclusions: [],
  requirements: [
    {
      id: "person_role-1",
      scope: "person_role",
      importance: "hard",
      description: "owners",
      sourcePhrase: "owners",
      acceptableTerms: ["owner", "founder"],
      queryable: true,
    },
    {
      id: "company_type-1",
      scope: "company_type",
      importance: "hard",
      description: "Agency",
      sourcePhrase: "Agency",
      acceptableTerms: ["agency"],
      queryable: true,
    },
  ],
};

test("checkStrictContradiction quality gates", async (t) => {
  await t.test("fails company pages as person_role", () => {
    const hit = checkStrictContradiction(
      {
        fullName: "Verdeschi Realty",
        currentCompany: "Verdeschi Realty",
        currentTitle: "Owner, Verdeschi Realty",
      },
      agencyContract,
    );
    assert.ok(hit);
    assert.equal(hit?.requirementId, "person_role");
  });

  await t.test("fails wrong-vertical agencies as company_type", () => {
    const realty = checkStrictContradiction(
      {
        fullName: "Jane Doe",
        currentTitle: "Owner",
        currentCompany: "Verdeschi Realty",
        industry: "Real Estate",
      },
      agencyContract,
    );
    assert.ok(realty);
    assert.equal(realty?.requirementId, "company_type-1");

    const cannabis = checkStrictContradiction(
      {
        fullName: "Paul Yau",
        currentTitle: "Co-Founder",
        currentCompany: "The Travel Agency: A Cannabis Store",
        industry: "Cannabis Retail",
      },
      agencyContract,
    );
    assert.ok(cannabis);
    assert.equal(cannabis?.requirementId, "company_type-1");
  });

  await t.test("passes genuine digital agency owners", () => {
    const hit = checkStrictContradiction(
      {
        fullName: "Jane Smith",
        currentTitle: "Founder",
        currentCompany: "Acme Digital",
        industry: "Marketing and Advertising",
        decisionMakerVerification: { ignoredTitle: false, confidence: 8 },
        location: "Austin, Texas",
      },
      agencyContract,
    );
    assert.equal(hit, null);
  });

  await t.test("fails ghost profiles as authority", () => {
    const hit = checkStrictContradiction(
      {
        fullName: "Ghost Person",
        currentTitle: "Founder",
        currentCompany: "Acme Digital",
        industry: "Marketing and Advertising",
        decisionMakerVerification: { ignoredTitle: false, confidence: 8 },
        _rawDossier: { followers: 0, connections: 12 },
      },
      agencyContract,
    );
    assert.ok(hit);
    assert.equal(hit?.requirementId, "authority");
  });

  await t.test("does not fail named-vertical contracts", () => {
    const contract = {
      ...agencyContract,
      brief: "Real estate agency owners in Texas",
    };
    const hit = checkStrictContradiction(
      {
        fullName: "Jane Doe",
        currentTitle: "Owner",
        currentCompany: "Verdeschi Realty",
        industry: "Real Estate",
        decisionMakerVerification: { ignoredTitle: false, confidence: 8 },
      },
      contract,
    );
    assert.equal(hit, null);
  });
});

test("intent backstop synthesis", async (t) => {
  await t.test("adds soft signal requirement when intentSpec has terms but no signal req", () => {
    const brief = "Agency owners in North America needing an extra hand with n8n workflows";
    const fallback = buildDeterministicProspectContract(brief, {});
    const contract = normalizeProspectContract(
      {
        authorityRequired: true,
        exclusions: [],
        identitySpec: {
          roles: ["owner"],
          locations: ["North America"],
          companyTypes: ["agency"],
          industries: [],
        },
        intentSpec: {
          toolingKeywords: ["n8n", "API integrations"],
          hiringSignals: [],
          painSignals: ["delivery bottlenecks"],
          growthSignals: [],
        },
        requirements: [
          {
            id: "person_role-1",
            scope: "person_role",
            importance: "hard",
            description: "owners",
            sourcePhrase: "owners",
            acceptableTerms: ["owner", "founder"],
            queryable: true,
          },
          {
            id: "company_type-1",
            scope: "company_type",
            importance: "hard",
            description: "Agency",
            sourcePhrase: "Agency",
            acceptableTerms: ["agency"],
            queryable: true,
          },
        ],
        initialQueries: [{ query: "agency owner" }],
      },
      brief,
      fallback,
    );
    const signalReqs = contract.requirements.filter(
      (r) => r.scope === "signal" || r.evidenceModality === "open_web_signal",
    );
    assert.equal(signalReqs.length, 1);
    assert.equal(signalReqs[0].importance, "soft");
    assert.ok(signalReqs[0].acceptableTerms.some((term: string) => /n8n/i.test(term)));
  });

  await t.test("does not duplicate when a signal requirement already exists", () => {
    const brief = "Founders hiring n8n developers";
    const fallback = buildDeterministicProspectContract(brief, {});
    const contract = normalizeProspectContract(
      {
        authorityRequired: true,
        exclusions: [],
        intentSpec: { toolingKeywords: ["n8n"], hiringSignals: [], painSignals: [], growthSignals: [] },
        requirements: [
          {
            id: "person_role-1",
            scope: "person_role",
            importance: "hard",
            description: "founders",
            sourcePhrase: "founders",
            acceptableTerms: ["founder"],
            queryable: true,
          },
          {
            id: "signal-1",
            scope: "signal",
            importance: "soft",
            description: "hiring n8n",
            sourcePhrase: "hiring",
            acceptableTerms: ["hiring", "n8n"],
            queryable: true,
          },
        ],
        initialQueries: [{ query: "founder n8n" }],
      },
      brief,
      fallback,
    );
    assert.equal(
      contract.requirements.filter(
        (r) => r.scope === "signal" || r.evidenceModality === "open_web_signal",
      ).length,
      1,
    );
  });

  await t.test("G10: b2b_saas guard ignores consulting in summary, keeps company hits", () => {
    const regex = getWrongVerticalRegexForCluster('b2b_saas');
    assert.ok(regex);
    const pastCareer = {
      currentCompany: "Acme SaaS", currentTitle: "Founder",
      summary: "Previously led a consulting practice",
    };
    assert.equal(candidateMatchesWrongVertical(pastCareer, regex!, 'b2b_saas'), null);
    const consultingFirm = { currentCompany: "Smith Consulting Group", industry: "consulting", currentTitle: "Partner" };
    assert.ok(candidateMatchesWrongVertical(consultingFirm, regex!, 'b2b_saas'));
  });
});
