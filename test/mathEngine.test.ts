import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleGamma,
  sampleBeta,
  scoreAdaptiveArm
} from '../server/leadSearch/adaptiveScheduler.js';
import {
  computeBM25PlusScore,
  BM25CorpusTracker,
  computeParetoFrontier,
  computeEpistemicCredibleInterval,
  computeScoreBreakdown,
  rankLeadForFinalSelection
} from '../server/leadSearch/scoring.js';
import {
  computeCareerTrajectoryDCR,
  verifyDecisionMakerFromEvidence
} from '../server/leadSearch/verification.js';

test('Thompson Sampling MAB: Gamma & Beta variate generators produce valid distributions', () => {
  for (let i = 0; i < 50; i++) {
    const g = sampleGamma(2.5);
    assert.ok(g > 0, `Gamma variate should be positive, got ${g}`);

    const b = sampleBeta(3.0, 5.0);
    assert.ok(b >= 0 && b <= 1, `Beta variate should be in [0, 1], got ${b}`);
  }
});

test('Thompson Sampling MAB: scoreAdaptiveArm produces higher scores for high-yield arms', () => {
  const highYieldRow = {
    family: 'hiring',
    lane: 'person',
    provider: 'tavily',
    outcome_runs: 5,
    qualified_candidates: 12,
    returned_candidates: 10,
    unique_candidates: 25,
    rescued_candidates: 0,
    duplicate_candidates: 1,
    provider_units: 5,
    search_latency_ms: 1200
  };

  const lowYieldRow = {
    family: 'generic',
    lane: 'person',
    provider: 'tavily',
    outcome_runs: 5,
    qualified_candidates: 0,
    returned_candidates: 0,
    unique_candidates: 5,
    rescued_candidates: 4,
    duplicate_candidates: 10,
    provider_units: 5,
    search_latency_ms: 3000
  };

  const highArm = scoreAdaptiveArm(highYieldRow, 10, 1.25, true);
  const lowArm = scoreAdaptiveArm(lowYieldRow, 10, 1.25, true);

  assert.ok(highArm.score > lowArm.score, `High-yield arm score (${highArm.score}) should exceed low-yield arm score (${lowArm.score})`);
  assert.ok(highArm.alpha && lowArm.alpha && highArm.alpha > lowArm.alpha, `High-yield arm alpha (${highArm.alpha}) should exceed low-yield arm alpha (${lowArm.alpha})`);
  assert.ok(highArm.thompsonSample !== undefined && highArm.thompsonSample >= 0 && highArm.thompsonSample <= 1, 'Thompson sample must be in [0, 1]');
});

test('Okapi BM25+: length-normalized term saturation and IDF weighting', () => {
  const tracker = new BM25CorpusTracker();
  tracker.registerDocument('AI agency founder building autonomous agentic workflows for enterprise sales');
  tracker.registerDocument('Senior software engineer working on frontend React and Tailwind interfaces');
  tracker.registerDocument('Growth marketing director specializing in B2B SaaS pipeline lead generation');
  const stats = tracker.getStats();

  assert.equal(stats.totalDocs, 3);
  assert.ok(stats.avgDocLength > 5);

  const relevantDoc = 'Founder and CEO of AI Agency scaling agentic automation workflows';
  const irrelevantDoc = 'Real estate agent selling residential properties in Miami';

  const relevantScore = computeBM25PlusScore(relevantDoc, ['ai', 'agency', 'agentic', 'automation'], stats);
  const irrelevantScore = computeBM25PlusScore(irrelevantDoc, ['ai', 'agency', 'agentic', 'automation'], stats);

  assert.ok(relevantScore > 0, `Relevant document should receive positive BM25+ score, got ${relevantScore}`);
  assert.equal(irrelevantScore, 0, `Irrelevant document should receive 0 score, got ${irrelevantScore}`);
  assert.ok(relevantScore <= 10, `Score should be clamped to 10, got ${relevantScore}`);
});

test('Career Trajectory DCR: multi-role career history with exponential recency decay', () => {
  const serialExecutive = [
    { title: 'Founder & CEO', company: 'Apex AI Labs', description: 'Building AI agency automation systems' },
    { title: 'VP of Engineering', company: 'TechCorp Enterprise', description: 'Led 40 AI and software engineers' },
    { title: 'Head of Product', company: 'CloudScale Inc', description: 'Product strategy for SaaS platforms' }
  ];

  const juniorEngineer = [
    { title: 'Junior Frontend Developer', company: 'WebStudio', description: 'HTML CSS maintenance' },
    { title: 'Intern', company: 'SmallApp', description: 'Assisting development team' }
  ];

  const execTrajectory = computeCareerTrajectoryDCR(serialExecutive, ['ai', 'agency', 'engineering']);
  const juniorTrajectory = computeCareerTrajectoryDCR(juniorEngineer, ['ai', 'agency', 'engineering']);

  assert.ok(execTrajectory.trajectoryScore >= 7.5, `Serial executive should score >= 7.5, got ${execTrajectory.trajectoryScore}`);
  assert.ok(juniorTrajectory.trajectoryScore <= 5.0, `Junior profile should score <= 5.0, got ${juniorTrajectory.trajectoryScore}`);
  assert.ok(execTrajectory.trajectoryScore > juniorTrajectory.trajectoryScore);

  // Verification integration
  const verification = verifyDecisionMakerFromEvidence({
    query: 'AI agency founder',
    currentTitle: 'Founder & CEO',
    currentCompany: 'Apex AI Labs',
    experiences: serialExecutive
  });

  assert.ok(verification.confidence >= 7.0, `Confidence should be high, got ${verification.confidence}`);
  assert.ok(verification.trajectoryScore && verification.trajectoryScore >= 7.5);
});

test('Pareto Skyline: identifies non-dominated specialist outlier candidates', () => {
  const candidateHighIntent = {
    fullName: 'Alice Specialist',
    decisionMakerVerification: { confidence: 6 },
    companyIntentEvidence: { evidenceQuality: 'good', tfidfWeightedScore: 0.9 },
    evidence: { evidenceQuality: 'good' }
  };

  const candidateHighAuthority = {
    fullName: 'Bob Executive',
    decisionMakerVerification: { confidence: 10 },
    companyIntentEvidence: { evidenceQuality: 'weak' },
    evidence: { evidenceQuality: 'weak' }
  };

  const candidateDominated = {
    fullName: 'Charlie Weak',
    decisionMakerVerification: { confidence: 4 },
    companyIntentEvidence: { evidenceQuality: 'weak' },
    evidence: { evidenceQuality: 'weak' }
  };

  const { skyline, nonSkyline } = computeParetoFrontier([
    candidateHighIntent,
    candidateHighAuthority,
    candidateDominated
  ]);

  const skylineNames = skyline.map(c => c.fullName);
  const nonSkylineNames = nonSkyline.map(c => c.fullName);

  assert.ok(skylineNames.includes('Alice Specialist'), 'High-intent specialist must be on Pareto Skyline');
  assert.ok(skylineNames.includes('Bob Executive'), 'High-authority executive must be on Pareto Skyline');
  assert.ok(nonSkylineNames.includes('Charlie Weak'), 'Dominated candidate must be excluded from Pareto Skyline');
});

test('Epistemic Uncertainty: 95% Credible Interval bounds and uncertainty calibration', () => {
  const highCertaintyLead = {
    scout: { sourceCount: 3 },
    evidence: { snippets: ['Snippet 1', 'Snippet 2', 'Snippet 3', 'Snippet 4'], evidenceQuality: 'good' }
  };

  const lowCertaintyLead = {
    scout: { sourceCount: 1 },
    evidence: { snippets: ['Short snippet'], evidenceQuality: 'weak' }
  };

  const pointScore = 8.0;
  const highCertCI = computeEpistemicCredibleInterval(highCertaintyLead, pointScore);
  const lowCertCI = computeEpistemicCredibleInterval(lowCertaintyLead, pointScore);

  assert.ok(highCertCI.uncertainty < lowCertCI.uncertainty, `High certainty uncertainty (${highCertCI.uncertainty}) should be lower than low certainty (${lowCertCI.uncertainty})`);
  assert.ok(highCertCI.lower <= pointScore && highCertCI.upper >= pointScore, 'Point score should lie within Credible Interval');
  assert.ok(highCertCI.lower >= 0 && highCertCI.upper <= 10, 'Credible interval bounds must lie within [0, 10]');

  // ScoreBreakdown integration check
  const breakdown = computeScoreBreakdown(highCertaintyLead, 'good', 'tavily', { confidence: 9, ignoredTitle: false });
  assert.ok(breakdown.confidenceInterval !== undefined, 'Score breakdown must attach confidenceInterval');
  assert.ok(breakdown.confidenceInterval.lower <= breakdown.finalScore);
  assert.ok(breakdown.confidenceInterval.upper >= breakdown.finalScore);
});
