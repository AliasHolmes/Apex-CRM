# Session 3 (`ad3b9625`) Telemetry Baseline

## 1. Session Metadata

- **Session ID**: `ad3b9625-01bc-4af2-9b16-4ff313aee33c`
- **Brief / Prompt**: `"AI service provider firm and agency owner from New Zealand"`
- **Target Limit**: 20 leads
- **Started At**: `2026-10-04T22:50:33.120Z`
- **Completed At**: `2026-10-05T00:13:39.247Z`
- **Total Duration**: 1h 23m 6s (4,986.1s)
- **Status**: `success` (Stop reason: `max_rounds`)
- **Outcome**: 9 qualified leads found (all 9 found in Rounds 1–3; Rounds 4–6 yielded 0 leads)

---

## 2. Per-Round Stage Wall Times (Critical Path)

Data extracted from `formatRoundCriticalPath` logs in `search_logs`:

| Round | Yield | Plan | Search | Extract | Enrich | Judge | Total Wall |
|---|---|---|---|---|---|---|---|
| **Round 1** | 3 leads | 4.5s | 19.0s | 119.7s | 142.4s | 122.3s | **407.8s** (~6.8 min) |
| **Round 2** | 5 leads | 145.1s | 11.5s | 233.8s | 123.4s | 524.2s | **1037.9s** (~17.3 min) |
| **Round 3** | 1 lead | 249.1s | 29.5s | 109.0s | 29.8s | 282.3s | **699.7s** (~11.7 min) |
| **Round 4** | 0 leads | 135.5s | 52.6s | 172.3s | 9.7s | 292.2s | **662.3s** (~11.0 min) |
| **Round 5** | 0 leads | 273.8s | 49.7s | 209.7s | 34.2s | 239.1s | **806.4s** (~13.4 min) |
| **Round 6** | 0 leads | 259.5s | 49.7s | 126.0s | 88.6s | 421.5s | **945.2s** (~15.8 min) |
| **Total** | 9 leads | **1067.5s** | **212.0s** | **970.5s** | **428.1s** | **1881.6s** | **4559.3s** |

---

## 3. Decision Gate: Zero-Novelty Fast Path Evaluation

The Decision Gate checks whether `extract + enrich + judge` exceeds 50% of the wall-clock time in zero-yield rounds (Rounds 4–6):

- **Round 4**: Extract ($172.3\text{s}$) + Enrich ($9.7\text{s}$) + Judge ($292.2\text{s}$) = $474.2\text{s}$ out of $662.3\text{s}$ = **71.6%**
- **Round 5**: Extract ($209.7\text{s}$) + Enrich ($34.2\text{s}$) + Judge ($239.1\text{s}$) = $483.0\text{s}$ out of $806.4\text{s}$ = **59.9%**
- **Round 6**: Extract ($126.0\text{s}$) + Enrich ($88.6\text{s}$) + Judge ($421.5\text{s}$) = $636.1\text{s}$ out of $945.2\text{s}$ = **67.3%**
- **Average across Zero-Yield Rounds**: **66.3%**

**Decision**: `extract + enrich + judge` substantially exceeds the 50% threshold. Therefore, **Phase 3F ("zero-novelty fast path") is CONFIRMED**: when query novelty is 0 and no fresh candidates are returned, downstream extract/enrich/judge work must be bypassed to avoid burning 8–12 minutes per stalled round.

---

## 4. Dispatched Queries by Round (R1–R6)

1. `site:linkedin.com/in/ agency owner AI services New Zealand service provider`
2. `site:linkedin.com/in/ founder AI consultancy New Zealand`
3. `site:linkedin.com/in/ managing director AI agency Auckl New Zealand`
4. `site:linkedin.com/in/ co-founder AI service provider Wellington`
5. `site:linkedin.com/in/ owner AI automation agency Christchurch`
6. `site:linkedin.com/in/ principal AI consultancy Tauranga New Zealand`
7. `site:linkedin.com/in/ CEO AI integration Hamilton New Zealand`
8. `site:linkedin.com/in/ founder AI automation Dunedin New Zealand`
9. `site:linkedin.com/in/ co-founder AI services "Business Development" service provider New Zealand`
10. `site:linkedin.com/in/ founder AI automation Auckland service provider`
11. `site:linkedin.com/in/ managing director AI integration Wellington service provider`
12. `site:linkedin.com/in/ co-founder generative AI New Zealand`
13. `AI services firm New Zealand -SaaS agency owner`
14. `site:linkedin.com/in/ principal AI consulting firm New Zealand`
15. `site:linkedin.com/in/ CEO generative AI agency Aotearoa`
16. `site:linkedin.com/in/ agency owner AI automation Wellington service provider`
17. `AI consultancy companies Christchurch agency owner`
18. `site:linkedin.com/in/ AI consultancy government founder New Zealand`
19. `site:linkedin.com/in/ AI services financial reporting director NZ service provider`
20. `site:linkedin.com/in/ AI agency co-founder Aotearoa`
21. `New Zealand AI consultancy firms agency owner`
22. `AI service provider agency owner Auckland New Zealand`
23. `AI service provider founder Wellington New Zealand`
24. `site:linkedin.com/in/ AI implementation agency CEO New Zealand service provider`
25. `site:linkedin.com/in/ "machine learning consultancy" managing director NZ AI service provider`
26. `site:linkedin.com/in/ AI transformation services co-founder Auckland`
27. `New Zealand AI implementation agencies agency owner AI service provider`
28. `AI service provider agency owner Christchurch New Zealand`
29. `AI service provider founder Christchurch New Zealand`

---

## 5. Withheld Candidates Audit

All 10 candidates withheld by the admission gate in Session 3 failed due to unproven company type:

1. **Round 2 (23:15:56Z)**: Kara Smith — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
2. **Round 2 (23:17:01Z)**: Anna Campbell — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
3. **Round 2 (23:17:01Z)**: Nick Kemp — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
4. **Round 2 (23:17:01Z)**: Theo Newton — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
5. **Round 3 (23:28:53Z)**: Tim Boyne — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
6. **Round 3 (23:28:53Z)**: Shakeel Ahmed — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
7. **Round 3 (23:28:53Z)**: Michael Friedberg — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
8. **Round 4 (23:39:57Z)**: Toby Sellers — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
9. **Round 5 (23:53:29Z)**: Sam Sutherland, MBA — *"Company type is the defining requirement of this brief and was not proven (unknown)."*
10. **Round 5 (23:53:29Z)**: Ben Walker — *"Company type is the defining requirement of this brief and was not proven (unknown)."*

---

## 6. James McCombe Fixture Data (For Phase 1B Tests)

Raw stored lead data from `checkpoint_json` in `mining_sessions`:

```json
{
  "fullName": "James McCombe",
  "currentTitle": "",
  "headline": "I build AI automation that runs",
  "currentCompany": "Mitori.ai",
  "titleSource": undefined,
  "qualification": {
    "policyVersion": "evidence-contract-v10",
    "verdict": "qualified",
    "qualificationSource": "llm",
    "finalScore": 8.22,
    "requirements": [
      {
        "requirementId": "person_role-1",
        "status": "pass",
        "fabricatedPass": false,
        "evidenceId": "e_company_attr",
        "evidenceQuote": "Auckland-based founder delivering AI automation services to clients."
      },
      {
        "requirementId": "r2",
        "status": "pass",
        "fabricatedPass": false,
        "evidenceId": "e_company_attr",
        "evidenceQuote": "Business Model: b2b_services. Industry: AI automation services."
      },
      {
        "requirementId": "r3",
        "status": "pass",
        "fabricatedPass": false,
        "evidenceId": "e0",
        "evidenceQuote": "Location: Auckland, New Zealand Industry: AI automation"
      }
    ],
    "reason": "Strong fit as a New Zealand founder providing client-facing AI automation services.",
    "semanticFit": 9,
    "evidenceConfidence": 8,
    "authorityFit": 8,
    "scoresOmitted": false
  }
}
```
- **Expected Backfilled Title**: `"founder"` (or `"Founder"` with canonical capitalization).
- **Expected Title Source**: `"inferred_from_qualification"`.
