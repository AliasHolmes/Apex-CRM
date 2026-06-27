import type { EvidenceQuality, LeadSourceProvider } from './scoring.js';

export type LeadEvidence = {
  sourceUrl: string;
  sourceProvider: LeadSourceProvider;
  sourceQuery: string;
  sourceRound: number;
  evidenceQuality: EvidenceQuality;
  snippets: string[];
  whyThisLead?: string;
};

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

export function snippetsFromEvidenceBlock(evidenceBlock: string, maxSnippets = 3) {
  return evidenceBlock
    .split(/\r?\n/)
    .map(line => normalizeWhitespace(line.replace(/^\[[^\]]+\]\s*/, '')))
    .filter(line => line && !line.startsWith('LINK:') && !line.startsWith('SOURCE_PROVIDER:'))
    .slice(0, maxSnippets)
    .map(line => line.length > 260 ? `${line.slice(0, 257).trim()}...` : line);
}

export function inferTavilyEvidenceQuality(item: any): EvidenceQuality {
  const raw = normalizeWhitespace(item?.raw_content || '');
  const content = normalizeWhitespace(item?.content || '');
  if (raw.length >= 700) return 'good';
  if (raw.length >= 180 || content.length >= 120) return 'partial';
  return 'weak';
}

export function createLeadEvidence(params: {
  sourceUrl: string;
  sourceProvider: LeadSourceProvider;
  sourceQuery: string;
  sourceRound: number;
  evidenceQuality: EvidenceQuality;
  evidenceBlock: string;
  whyThisLead?: string;
}): LeadEvidence {
  return {
    sourceUrl: params.sourceUrl,
    sourceProvider: params.sourceProvider,
    sourceQuery: params.sourceQuery,
    sourceRound: params.sourceRound,
    evidenceQuality: params.evidenceQuality,
    snippets: snippetsFromEvidenceBlock(params.evidenceBlock),
    whyThisLead: params.whyThisLead,
  };
}

export function sourceProviderForScore(provider: 'brightdata' | 'tavily' | 'cache'): LeadSourceProvider {
  return provider;
}
