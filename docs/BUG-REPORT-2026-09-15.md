# Deep Codebase Bug Report — Apex CRM

Date: 2026-09-15
Scope: full `server/` + `src/` tree (~42,000 LOC TypeScript), 633-test suite
Baseline: `tsc --noEmit` clean, `npm run test:all` → **633 pass / 0 fail** (both before and after the fixes below)

This is a fresh pass, not a re-run of `ENGINE-AUDIT-2026-09-13.md` or
`AUDIT-VERIFICATION-2026-09-15.md`. Every finding below was reproduced with a
throwaway probe harness against the real modules before any source was changed.

---

## Severity summary

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Score-scale heuristic inverts ranking at exactly `1.0` | **High** | Fixed |
| 2 | Site-probe SSRF guard bypassable via HTTP redirect | **High** | Fixed |
| 3 | Configured round cap silently overridden (6 → 10 rounds) | **Medium** | Fixed |
| 4 | Location hard requirement auto-passes from the search query | **Medium** | Fixed |
| 5 | `readLeadsStats` inflates weak leads 10× | **Medium** | Fixed |
| 6 | Recovery guidance reports *matching* locations/roles as non-matching | **Medium** | Fixed |
| 7 | Ablation strips the identity anchor from a query | **Medium** | Fixed |
| 8 | `LLM_MAX_RETRIES` still overridden on the 429 path | Low | Reported only |

Regression coverage: `test/deepAuditRegression.test.ts` (25 tests) pins every fix
above. Verified non-vacuous — reverting finding 1 makes exactly the 2 ranking
assertions fail.


---

## Finding 1 — Score-scale heuristic inverts the ranking at exactly `1.0` (High)

### The defect

The engine has a scale-sniffing idiom for values that may arrive on either a
`0–1` probability scale or a `1–10` score scale:

```ts
rawBase <= 1.0 && rawBase > 0 ? rawBase * 10 : rawBase
```

The upper bound is inclusive, but **`1` is a valid and meaningful `1–10` score** —
it is the worst a candidate can receive. Any candidate that scores exactly `1.0`
is therefore multiplied by ten and promoted to the top of the scale.

The project already knows the correct form: `finalistJudge.normalizeScoreTo10`
(line 63) and `scoutScoring.selectDiversifiedLeads` (line 127) both use the
**exclusive** `< 1.0`. The prior audit's finding 2.2 ("`1 → 10` score inflation")
fixed exactly this in `finalistJudge.ts` — but the same idiom survived in five
other places, so the fix was only ever applied to one of six sites.

### Reproduction (measured, before fix)

```
rankLeadForFinalSelection vs qualification.finalScore
  finalScore=0.5  -> 4.73
  finalScore=1    -> 4.83   <-- WORST score, HIGHEST rank
  finalScore=1.2  -> 4.65
  finalScore=2    -> 4.67
  finalScore=3    -> 4.69
  finalScore=5    -> 5.48
  finalScore=10   -> 5.58

mapCandidateToPersistedLead({ finalSelectionScore: 1 })
  -> compositeScore=100  predictiveScore=90      (should be 10 / 9)

applyPostIntentDelta(finalScore=1)      -> 10     (jumps to maximum)
applyIntentEnrichmentDelta(finalScore=1) -> 10    (jumps to maximum)
```

The ranking inversion is observable in the selector itself. Given a pool where
`a`, `b`, `c` score `9` and `d` scores `1`:

```
computeMMRDiversitySelection(pool, 2, 0.75)
  before: ids = d,a     <-- picked the worst candidate FIRST
  after:  ids = a,d
```

`applySigmoidScaling` clamps to `[1, 10]` and `applyHardCaps` clamps to
`Math.max(capped, 1)`, so `1.0` is not a theoretical value — it is the exact
output for every candidate at the bottom of the distribution, and for every
candidate the judge marked `reject` / `auto_reject` (`applyHardCaps` caps those
at `3.0`).

### Affected sites

| File | Line | Effect |
| --- | --- | --- |
| `server/leadSearch/scoring.ts` | 342 | `rankLeadForFinalSelection` — drives MMR, Pareto and final ordering |
| `server/leadSearch/scoring.ts` | 203 | `applyIntentEnrichmentDelta` — Phase 4 score |
| `server/leadSearch/scoring.ts` | 214 | `_priorScore` (Kalman prior) |
| `server/leadSearch/scoring.ts` | 224 | `applyPostIntentDelta` — Phase 5 score |
| `server/leadSearch/leadMapping.ts` | 28 | persisted `compositeScore` / `predictiveScore` |
| `src/context/LeadContext.tsx` | 586, 671 | client-side bulk-import + merge scoring |

### The fix

Added `normalizeToTenScale()` in `scoring.ts` as the single shared
implementation, with the rationale documented at the definition, and routed the
three pure-normalisation sites through it. The Kalman-prior site is deliberately
left as an inline `< 1.0` comparison, because a missing `_priorScore` must stay
`NaN` so the existing `Number.isFinite` guard falls through to `rawEnriched`
instead of fusing against a synthetic prior of `5`.

---

## Finding 2 — Site-probe SSRF guard bypassable via HTTP redirect (High)

### The defect

`siteProbe.groundCandidateWithSiteProbe` validated the host once and then fetched
with `redirect: 'follow'`:

```ts
if (!host || isPrivateOrInternalHost(host)) return null;   // guard: first URL only
...
const resp = await fetch(targetUrl, {
  ...
  redirect: 'follow',      // undici then follows 302 -> http://169.254.169.254/
});
```

Any public host the engine happens to probe could return `302 Location:
http://169.254.169.254/latest/meta-data/` and the request would be followed to
the cloud metadata endpoint. The guard only ever saw hop 1.

The sibling implementation in the same codebase already does this correctly:
`brightdata.scrapeAsMarkdown` uses `redirect: "manual"` inside a
`while (redirectCount <= maxRedirects)` loop and re-validates
`isPrivateOrInternalHost(nextHost)` on **every** hop. The site probe simply
diverged from it.

### Secondary gap in the shared guard

`isPrivateOrInternalHost` relied on `net.isIP()`, which rejects the numeric IPv4
literals that resolvers happily accept. Measured before the fix:

```
isPrivate('localhost.')   = false    # trailing root dot
isPrivate('127.0.0.1.')   = false    # trailing root dot
isPrivate('2130706433')   = false    # decimal form of 127.0.0.1
isPrivate('0177.0.0.1')   = false    # octal
isPrivate('0x7f000001')   = false    # hex
isPrivate('127.1')        = false    # shortened dotted form
isPrivate('224.0.0.1')    = false    # multicast
isPrivate('240.0.0.1')    = false    # reserved
```

Today this is latent rather than exploitable — both call sites
(`siteProbe.ts:98`, `:585`) pass a hostname already normalised by
`new URL()`, which canonicalises these forms — but the function is exported
through `brightdata.ts` and is one careless caller away from being a live hole.

### The fix

1. `siteProbe.ts` now follows redirects manually, capped at 3 hops, re-validating
   each `Location` host and returning `null` on any private destination.
2. `privateHosts.ts` gained `normalizeNumericHost()`, which canonicalises
   decimal / hex / octal / shortened dotted IPv4 literals to dotted-quad before
   the range checks (inet_aton semantics), plus a trailing-root-dot strip and
   explicit `224.0.0.0/4`, `240.0.0.0/4` and `192.0.0.0/24` ranges.

Post-fix, all eight bypasses above report `true`, and the existing
`siteProbeSsrfGuard` suite (which asserts `stripe.com` / `apexlead.io` remain
allowed) still passes.

---

## Finding 3 — Configured round cap silently overridden (Medium)

This resolves the open question left in `AUDIT-VERIFICATION-2026-09-15.md`
finding 5: *"Ten rounds against a documented cap of three … Worth investigating
how the run reached 10."*

### The mechanism

`discoveryEngine.ts` builds its round budget from
`buildCollectionCapacity({ maxRoundsCap: Number(process.env.LEAD_SEARCH_MAX_ROUNDS) })`,
so a configured `LEAD_SEARCH_MAX_ROUNDS="6"` correctly yields `maxRounds = 6`.
But inside the round loop an extension step then grows the budget against a
hard-coded ceiling of `10`:

```ts
round >= maxRounds &&
maxRounds < 10 &&                       // <-- ignores LEAD_SEARCH_MAX_ROUNDS
...
maxRounds = Math.min(maxRounds + 2, 10); // 6 -> 8 -> 10
```

So the operator's ceiling was honoured once at startup and then ignored: `6 → 8
→ 10`, which is exactly the 10 rounds observed in session
`10331776-f9ed-4a29-a79e-e98dab5a73ea`. It also contradicts
`CONTEXT.md` ("tight maximum round bounds (2–4 rounds)") and
`collectionCapacity.ts:117` (`defaultMaxRoundsCap = 3` for targets ≤ 30).

### The fix

The extension ceiling is now derived from configuration. When
`LEAD_SEARCH_MAX_ROUNDS` is set, the configured value is authoritative and the
extension may not exceed it (with a configured `6`, no extension happens at all).
When it is unset, the original recovery ceiling of `10` is preserved so the
`progressiveQualification` recovery behaviour is unchanged. The effective ceiling
is now logged on every extension.

**Remaining doc inconsistency (not fixed, needs a product decision):** with the
env var unset, a target of 30 can still legitimately run up to 10 rounds. Either
`CONTEXT.md`'s "2–4 rounds" claim or the recovery ceiling needs to change.

---

## Finding 4 — Location hard requirement auto-passes from the search query (Medium)

### The defect

`structuredFieldsForRequirement` falls back to the query that *surfaced* the
candidate when the profile has no location:

```ts
case 'person_location': {
  const locationFallback = (!lead.location && !profile.location)
    ? (lead._sourceQuery || lead.evidence?.sourceQuery || lead.sourceQuery)
    : undefined;
  return [lead.location, profile.location, locationFallback];
}
```

`hasStrictStructuredMatch` consumes that same list, and
`triPartitionCandidatesByEvidence` treats a full strict match as an
**auto-PASS** that skips the judge entirely. So a candidate discovered via
`"AI agency" founder New York`, with no location field at all, was auto-qualified
against a hard "must be in New York" requirement:

```
structuredFieldsForRequirement(...)      = [null, null, "AI agency founder New York"]
hasStrictStructuredMatch(...)            = true    <-- before fix
```

This is the prior audit's unfixed item 2.7. It was not addressed because a test
enshrines it (`blueprintBlueprintCoverage.test.ts:303`, "Must auto-qualify via
query anchor with 0 LLM tokens").

### The fix

The fallback is now diagnostic-only. `structuredFieldsForRequirement` takes
`options.includeQueryFallback` (default `true`, so the diagnostic field list is
unchanged) and `hasStrictStructuredMatch` passes `false`. A stated profile
location still auto-passes; an unstated one now goes to the judge, which is where
`person_location` already had `unknown`-tolerant handling.

The enshrining assertion was updated to `false` and a positive control was added
(`location: 'Sydney, Australia'` still auto-passes). **If the auto-pass was
intentional, revert this single change** — it is isolated to
`evidenceSelection.ts` and one test.

---

## Finding 5 — `readLeadsStats` inflates weak leads 10× (Medium)

### The defect

`leads.score` holds the promoted composite/predictive score. **Every** writer
produces a `0–100` value: `leadMapping.mapCandidateToPersistedLead`
(`Math.round(backendFinalScore * 10)`), `predictiveScoreFromComposite` (0–96) and
`scoreLeadDeterministically` (0–100). The stats query nonetheless rescales
anything `<= 10` as if it were a `0–10` score:

```sql
AVG(CASE WHEN score IS NOT NULL AND score > 0
         THEN (CASE WHEN score <= 10 THEN score * 10 ELSE score END)
         ELSE NULL END)
```

A composite of `10` (10%) was therefore counted as `100` in
`averageQualification`. Verified against the live database — **2,273 scored
leads, min 0, max 92, and zero rows on a 0–10 scale** — so the branch could only
ever misfire, never legitimately fire.

The same double-normalisation exists client-side:
`CrmOverview.normalizedQualificationScore` (`score <= 10 ? score * 10 : score`)
feeds thresholds of 80/60/40, so a composite of `10` was labelled **"Top tier"**
instead of "Low priority"; `LeadContext.tsx:63` feeds the same inflated value
into the sidebar average.

### The fix

Removed the rescale in all three places, with the 0–100 contract documented at
each site. Post-fix, `finalSelectionScore: 1` persists as
`compositeScore 10 / predictiveScore 9` instead of `100 / 90`.

---

## Finding 6 — Recovery guidance reports *matching* attributes as non-matching (Medium)

### The defect

`buildRoundDiagnostics` is the feedback loop that tells the LLM strategist what the
last round got wrong. It collected candidate attributes unconditionally — there was
no "does this match the contract?" test at all:

```ts
const nonMatchingLocations = new Set<string>();
for (const lead of params.leads) {
  const loc = String(lead.location || '').trim();
  if (loc && loc.length > 2 && loc.length < 50) nonMatchingLocations.add(loc);   // every location
  ...
}
```

Those sets are then injected verbatim into the strategist prompt:

- `searchSpec.buildRecoveryQueryPrompt` → `Observed non-matching locations: ...`
- `prospectContract.buildContractRefinementPrompt` →
  `Observed non-matching locations in prior round: [...]. Steer queries towards target contract locations.`

`params.leads` is `acceptedLeads.slice(acceptedCountBeforeRound)` — candidates that
already passed the pre-filter and the score floor. So their locations and titles are
predominantly *contract-satisfying*, and the strategist was being instructed to steer
away from them. For a London brief, `Manchester, UK` was reported as a non-matching
location; for a founder/owner/CEO brief, the title `Owner` was reported as a
non-matching title.

The existing test (`pillar1SearchStrategy.test.ts`) asserted that the non-matching
entries were present but never that the *matching* entry was absent — which is why
this survived.

### A first attempt that was wrong, and why it matters

The obvious fix — reuse `matchesRequirement()` for the decision — is incorrect. That
function is a permissive **pass-rate heuristic**; its `person_role` fallback treats any
title matching `\b(vp|director|head of|...)\b` as satisfying *any* role requirement, so
`VP Marketing` counted as satisfying a founder/owner/CEO requirement and vanished from
the non-matching list. Reusing it silently over-suppressed the very signal the
diagnostics exist to produce.

The fix uses a precise term check on the attribute's own text instead
(`attributeSatisfiesTerms`), and treats "the contract has no requirement of this scope"
as satisfied — so a location is never reported as non-matching when the contract says
nothing about location.

### Verification

```
contract: founders in London (role terms: founder|owner|ceo, location terms: london|uk)
leads:    VP Marketing / New York, USA
          Senior Recruiter / San Francisco, CA
          Owner / Manchester, UK

before:  locations = [New York, USA, San Francisco, CA, Manchester, UK]
         roles     = [VP Marketing, Senior Recruiter, Owner]
after:   locations = [New York, USA, San Francisco, CA]
         roles     = [VP Marketing, Senior Recruiter]
```

The test was strengthened to assert the matching entries are **absent**, and a second
case pins the "no requirement of this scope" behaviour.


## Finding 7 — Ablation strips the identity anchor from a query (Medium)

### The defect

`classifyAblationTier` ran its volatile-context **text scan before** the
identity check, so the scan's keyword list decided the tier of requirements that
were not about volatile context at all:

```ts
const fullText = `${requirement.description} ${requirement.sourcePhrase} ${(requirement.acceptableTerms || []).join(' ')}`;
if (requirement.scope === 'signal' || VOLATILE_CONTEXT_REGEX.test(fullText)) {
  return ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT;   // 'cloud', 'salesforce', 'hiring', 'stack'...
}
if (requirement.requirementClass === 'identity_hard' || requirement.scope === 'person_role' || ...) {
  return ABLATION_TIERS.TIER_1_IMMUTABLE_CORE;     // unreachable for these titles
}
```

`TIER_1_IMMUTABLE_CORE` is documented as **"NEVER ablated"**, and `ablateQueryTask`
even carries a dedicated immutable-core guard. But a role whose *title* contains a
volatile keyword never reached Tier 1:

```
classifyAblationTier(person_role, "Cloud Architect")             -> Tier 4  (should be Tier 1)
classifyAblationTier(person_role, "Head of Hiring")              -> Tier 4
classifyAblationTier(person_role, "Salesforce Administrator")    -> Tier 4
```

Because Tier 4 is ablated first, the recovery mechanism could delete the role term
outright, producing an anchor-less query:

```
query:   "cloud architect" London
before:  ablated -> "London"                (removed term: "cloud architect")
after:   ablated -> '"cloud architect"'     (removed term: "london", Tier 2)
```

A query with no role returns generic noise. Ablation is the last-resort recovery
path, so this converts a should-be-targeted retry into a wasted paid round — a
plausible contributor to the 10-round / 1.2%-yield baseline.

### Why the fix is scoped to role/identity only

The obvious fix — make scope authoritative over the text scan — is **wrong**, and
`test/constraintAblation.test.ts` proves it: a requirement compiled as
`company_type` but describing tooling (`"Snowflake stack"`) is *expected* to be
Tier 4 and ablatable. That is deliberate, so a volatile description must keep
outranking a firmographic scope.

The fix therefore exempts only `person_role` / `identity_hard` / explicit
`isImmutableCore` from the text scan (they are the tiers documented as
*unconditionally* immutable), and leaves `company_type` / `company_industry`
subject to it. The ordering rule is now written down at the function so it cannot
drift again.

---

## Finding 8 — `LLM_MAX_RETRIES` is still overridden on the 429 path (Low, reported only)

`AUDIT-VERIFICATION-2026-09-15.md` records finding 4.2 as *"Fixed properly:
`effectiveMaxRetries = maxRetries` — the `Math.max(…, 2)` override is gone."*
That is true for the general path (`llm.ts:382`), but the override survives for
429s specifically:

```ts
const statusMaxRetries = is429 ? Math.max(maxRetries, 2) : maxRetries;   // llm.ts:444
```

With the default `LLM_MAX_RETRIES=1`, a 429 gets `maxRetries = 2`, i.e. up to
three attempts on the same key before rotation. The operator's configured budget
is silently tripled for exactly the error class they set it for.

**Not changed.** This is a resilience trade-off, not a clear defect: the
baseline session showed a 39.8% LLM failure rate and 44% fallback usage, so
removing the 429 floor could trade correctness for throughput. The one-line fix
is `const statusMaxRetries = maxRetries;` (the existing `retry429` gate at line
381 already disables 429 retries when `LLM_MAX_RETRIES=0`). Recommend deciding
deliberately and then correcting the audit record either way.

---

## Verified clean (checked, no defect found)

Depth checks that came back negative, recorded so they are not re-investigated:

- **`withSequentialLLMExecution`** — the only call site is inside `fetchWithRetry`
  (`llm.ts:418`), and `sendChatCompletion` routes through `fetchWithRetry`, so
  every chat completion really is serialised. The claim in README §10 holds.
- **FTS5 rowid map (schema v21)** — `leads_ai` / `leads_ad` / `leads_au` triggers,
  the `WHEN`-clause short-circuit and the `ON CONFLICT` (rather than
  `INSERT OR REPLACE`) note are all correct, including the defensive orphan sweep.
- **`keyRotator`** — `isUsable`, cooldown expiry, the `exhausted` recovery
  condition, network-vs-key failure separation and the rotation loop all behave
  as documented.
- **TF-IDF two-pass** (`intentEnrichment.ts`) — `SignalCorpus.registerOccurrences`
  is called exactly once per company per pass, `runProviderQueue` is awaited
  before Pass 2, and `tfidfWeightedScore` is always defined, so the
  `intentData.tfidfWeightedScore.toFixed(3)` log line cannot throw.
- **`adaptiveScheduler`** — Marsaglia-Tsang `sampleGamma`, the `alpha < 1`
  boost, Beta-via-Gamma and the UCB/Thompson fusion are numerically sound; the
  contract-guard loop provably terminates.
- **`verification.verifyDecisionMakerFromEvidence`** — weak-title suppression,
  the consultant/specialist prefix escape and the student/assistant conflict
  overrides behave as intended.
- **`collectionCapacity.buildCollectionCapacity`** — pool multipliers, batch
  scaling, `requiredRounds` and the `maxRoundsCap` override are internally
  consistent for targets 1–200.
- **Dedupe / identity** (`leadDedupe.ts`) — `canonicalLinkedInIdentity` correctly
  refuses to mint a persisted identity from a bare string, and the
  name+company / name+domain fallbacks are correctly suppressed once a real
  LinkedIn identity exists.
- **`computeMMRDiversitySelection` / `computeParetoFrontier` / `normalizeScorePool`**
  — order-preserving and correctly bounded once Finding 1 was fixed.
- **`companiesMatch` / `CompanyRegistry.areEquivalent`** — investigated as a
  suspected false-positive source and **deliberately left alone**. `Apex AI` does
  match `Apex Tech`, because `INDUSTRY_QUALIFIERS` excludes `ai` / `tech` / `io` /
  `studio`. That is intended: the same firm appears as "TechFlow AI", "TechFlow
  Studio" and "techflow.io" across SERPs, and treating those as distinct companies
  would fragment one account into several. `test/signalStore.test.ts` and
  `test/twoFunnelEngine.test.ts` encode the tolerance explicitly. An attempt to
  tighten the qualifier set was reverted after it broke those tests; the behaviour
  is now pinned in `test/deepAuditRegression.test.ts` so it cannot be "fixed" into
  a regression. Worth knowing as a precision/recall trade-off, not a bug.

---

## Verification

| Check | Before | After |
| --- | --- | --- |
| `npm run typecheck` | clean | clean |
| `npm run test:all` | 633 pass / 0 fail | **658 pass / 0 fail** (+25 new) |
| `test/deepAuditRegression.test.ts` (new) | — | **25 pass** |
| Non-vacuous check (revert Finding 1) | — | 2 assertions fail, as intended |
| Probe: worst candidate ranks first | yes | no |
| Probe: SSRF literal bypasses blocked | 8 of 8 open | 8 of 8 blocked |
| Probe: matching location reported as non-matching | yes | no |
| Probe: role title misclassified as ablatable | 3 of 3 | 0 of 3 |
| Probe: ablation strips the role term | yes | no |

Files changed (11 files, plus 2 test files):

```
server/leadSearch/scoring.ts             normalizeToTenScale() + 4 call sites
server/leadSearch/leadMapping.ts         compositeScore/predictiveScore scale fix
server/leadSearch/siteProbe.ts           manual redirects with per-hop SSRF validation
server/leadSearch/evidenceSelection.ts   query fallback no longer auto-passes location
server/leadSearch/discoveryEngine.ts     round extension bounded by configuration
server/leadSearch/roundDiagnostics.ts    recovery guidance only reports non-matching attrs
server/leadSearch/constraintAblation.ts  identity/role exempted from the volatile text scan
server/services/privateHosts.ts          numeric-literal + root-dot + reserved-range hardening
server/db.ts                             removed 10x compositeScore inflation
src/components/CrmOverview.tsx           removed 10x compositeScore inflation
src/context/LeadContext.tsx              removed 10x inflation + `< 1.0` scale fix
test/deepAuditRegression.test.ts         NEW - 25 regression tests for findings 1-7
test/blueprintBlueprintCoverage.test.ts  assertion updated to the corrected contract
test/pillar1SearchStrategy.test.ts       strengthened: matching attrs must be absent
```

## Recommended follow-ups

1. **Re-run a live session and re-measure.** Findings 1, 6 and 7 all change which
   candidates survive selection and what guidance the strategist receives on every
   recovery round, so the 1.2% yield / 79% LLM-share baseline in the previous audit
   is no longer directly comparable. These three are also the most likely to move
   the round count and yield.
2. **Decide Finding 8** (429 retry floor) and correct the audit record either way.
3. **Reconcile the round-cap documentation** with the 10-round recovery ceiling
   that applies when `LEAD_SEARCH_MAX_ROUNDS` is unset.
4. **Consider a lint rule or shared helper** for the `<= 1.0 → ×10` idiom. It has
   now been fixed twice in two different files, which is the signature of a
   pattern that keeps getting reintroduced.
5. **Revisit the recovery-guidance predicates.** Finding 6 showed that
   `matchesRequirement` (permissive, for pass-rate estimation) and the strict
   auto-pass gate need different primitives. Three different callers now each
   apply their own notion of "matches" — worth naming them explicitly rather than
   discovering a fourth divergence.
