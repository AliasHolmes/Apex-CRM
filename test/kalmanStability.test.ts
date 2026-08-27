import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeKalmanFusedScore } from '../server/leadSearch/scoring.ts';

describe('Kalman filter numerical stability & NaN guards', () => {
  it('handles near-zero and zero process/observation noise without producing NaN or Infinity', () => {
    const scoreZeroNoise = computeKalmanFusedScore(7.5, 9.0, 0, 0);
    assert.equal(Number.isFinite(scoreZeroNoise), true);
    assert.equal(scoreZeroNoise >= 1 && scoreZeroNoise <= 10, true);

    const scoreTinyNoise = computeKalmanFusedScore(6.0, 8.0, 1e-18, 1e-18);
    assert.equal(Number.isFinite(scoreTinyNoise), true);
    assert.equal(scoreTinyNoise >= 1 && scoreTinyNoise <= 10, true);
  });

  it('handles invalid NaN or infinite inputs safely with fallback', () => {
    const scoreNaNPrior = computeKalmanFusedScore(NaN, 8.0, 1.0, 2.0);
    assert.equal(Number.isFinite(scoreNaNPrior), true);

    const scoreNaNObs = computeKalmanFusedScore(7.0, NaN, 1.0, 2.0);
    assert.equal(Number.isFinite(scoreNaNObs), true);
    assert.equal(scoreNaNObs, 7.0);

    const scoreInfNoise = computeKalmanFusedScore(7.0, 9.0, Infinity, 2.0);
    assert.equal(Number.isFinite(scoreInfNoise), true);
  });

  it('converges smoothly over repeated updates', () => {
    let score = 5.0;
    const observations = [8.0, 8.5, 9.0, 8.8, 9.2];
    for (const obs of observations) {
      score = computeKalmanFusedScore(score, obs, 1.0, 1.5);
      assert.equal(Number.isFinite(score), true);
      assert.equal(score >= 1 && score <= 10, true);
    }
    assert.equal(score > 7.5, true, 'Score should move upwards towards observations');
  });
});
