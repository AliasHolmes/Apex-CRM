import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRecognizedTool,
  TOOL_LEXICONS_BY_CLUSTER,
  UNIVERSAL_TOOLS_REGEX,
  buildDeterministicProspectContract
} from '../server/leadSearch/prospectContract.js';

describe('Tool Lexicon & Cross-Industry Tool Intelligence', () => {
  describe('isRecognizedTool()', () => {
    it('recognizes universal automation and productivity tools in any cluster', () => {
      const universalTools = ['n8n', 'zapier', 'make', 'hubspot', 'salesforce', 'airtable', 'notion', 'slack', 'excel', 'chatgpt'];
      for (const tool of universalTools) {
        assert.ok(isRecognizedTool(tool), `Expected '${tool}' to be recognized as a universal tool`);
        assert.ok(isRecognizedTool(tool, 'b2b_agency'), `Expected '${tool}' to be recognized in b2b_agency`);
        assert.ok(isRecognizedTool(tool, 'ecommerce_retail'), `Expected '${tool}' to be recognized in ecommerce_retail`);
      }
    });

    it('recognizes ecommerce and retail tools', () => {
      const ecomTools = ['shopify', 'klaviyo', 'woocommerce', 'magento', 'gorgias', 'recharge', 'shipbob'];
      for (const tool of ecomTools) {
        assert.ok(isRecognizedTool(tool, 'ecommerce_retail'), `Expected '${tool}' in ecommerce_retail`);
      }
    });

    it('recognizes healthcare practice management and EHR tools', () => {
      const healthTools = ['epic', 'cerner', 'athenahealth', 'drchrono', 'kareo', 'allscripts', 'veeva'];
      for (const tool of healthTools) {
        assert.ok(isRecognizedTool(tool, 'healthcare_life_sciences'), `Expected '${tool}' in healthcare_life_sciences`);
      }
    });

    it('recognizes legal and accounting professional services tools', () => {
      const profTools = ['clio', 'mycase', 'practice panther', 'quickbooks', 'xero', 'westlaw'];
      for (const tool of profTools) {
        assert.ok(isRecognizedTool(tool, 'professional_services'), `Expected '${tool}' in professional_services`);
      }
    });

    it('recognizes coaching and creator platforms', () => {
      const coachingTools = ['kajabi', 'teachable', 'thinkific', 'circle', 'convertkit', 'calendly'];
      for (const tool of coachingTools) {
        assert.ok(isRecognizedTool(tool, 'executive_coaching'), `Expected '${tool}' in executive_coaching`);
      }
    });

    it('recognizes field service and contractor tools', () => {
      const contractorTools = ['jobber', 'servicetitan', 'housecall pro', 'fieldedge'];
      for (const tool of contractorTools) {
        assert.ok(isRecognizedTool(tool, 'local_services'), `Expected '${tool}' in local_services`);
      }
    });

    it('rejects arbitrary generic words that are not software tools', () => {
      const nonTools = ['banana', 'meeting', 'bottleneck', 'owner', 'revenue', 'scaling', 'client', 'delivery'];
      for (const word of nonTools) {
        assert.ok(!isRecognizedTool(word), `Expected '${word}' to NOT be recognized as a tool`);
      }
    });

    it('exposes valid regex patterns in TOOL_LEXICONS_BY_CLUSTER and UNIVERSAL_TOOLS_REGEX', () => {
      assert.ok(UNIVERSAL_TOOLS_REGEX instanceof RegExp);
      assert.ok(UNIVERSAL_TOOLS_REGEX.test('n8n'));

      const expectedClusters = [
        'b2b_agency', 'b2b_saas', 'executive_coaching', 'ecommerce_retail',
        'healthcare_life_sciences', 'professional_services', 'local_services', 'manufacturing_industrial'
      ];
      for (const cluster of expectedClusters) {
        assert.ok(TOOL_LEXICONS_BY_CLUSTER[cluster] instanceof RegExp, `Cluster ${cluster} must have a RegExp`);
      }
    });
  });

  describe('buildDeterministicProspectContract() with tools', () => {
    it('extracts recognized tools from brief into toolingKeywords and signal requirements', () => {
      const brief = 'Agency owners in North America actively posting on LinkedIn about client delivery bottlenecks or needing an extra hand to build custom n8n workflows and API integrations';
      const contract = buildDeterministicProspectContract(brief);

      assert.ok(contract.intentSpec, 'contract must have intentSpec');
      assert.ok(
        contract.intentSpec.toolingKeywords.includes('n8n'),
        `intentSpec.toolingKeywords should include 'n8n', got: ${JSON.stringify(contract.intentSpec.toolingKeywords)}`
      );

      const signalReqs = contract.requirements.filter(r => r.scope === 'signal');
      assert.ok(signalReqs.length > 0, 'should generate at least one soft signal requirement');
    });

    it('extracts industry-specific tools from brief for ecommerce briefs', () => {
      const brief = 'Shopify store owners in California switching from Klaviyo to Omnisend';
      const contract = buildDeterministicProspectContract(brief);

      assert.ok(contract.intentSpec, 'contract must have intentSpec');
      assert.ok(
        contract.intentSpec.toolingKeywords.includes('shopify') || contract.intentSpec.toolingKeywords.includes('klaviyo'),
        `Expected shopify or klaviyo in toolingKeywords, got: ${JSON.stringify(contract.intentSpec.toolingKeywords)}`
      );
    });
  });
});
