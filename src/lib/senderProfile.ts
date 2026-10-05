export interface SenderProfile {
  senderName: string;
  senderCompany: string;
  valueProposition: string;
}

export const SENDER_PROFILE_STORAGE_KEY = 'apex-sender-profile';

/** First-run values. Once the user edits them the stored profile takes over. */
export const DEFAULT_SENDER_PROFILE: SenderProfile = {
  senderName: 'Arnob',
  senderCompany: 'Lead-Finder Pro',
  valueProposition:
    'building customized search-grounded workflows to automate verified prospect routing directly into active CRMs',
};

const MAX_FIELD_LENGTH = 600;

function pick(source: Record<string, unknown>, key: keyof SenderProfile, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : fallback;
}

/** Tolerant parse: corrupt or partial data falls back field by field to the defaults. */
export function parseSenderProfile(raw: string | null, defaults: SenderProfile = DEFAULT_SENDER_PROFILE): SenderProfile {
  if (!raw) return { ...defaults };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...defaults };
    const source = parsed as Record<string, unknown>;
    return {
      senderName: pick(source, 'senderName', defaults.senderName),
      senderCompany: pick(source, 'senderCompany', defaults.senderCompany),
      valueProposition: pick(source, 'valueProposition', defaults.valueProposition),
    };
  } catch {
    return { ...defaults };
  }
}

export function serializeSenderProfile(profile: SenderProfile): string {
  return JSON.stringify({
    senderName: profile.senderName.slice(0, MAX_FIELD_LENGTH),
    senderCompany: profile.senderCompany.slice(0, MAX_FIELD_LENGTH),
    valueProposition: profile.valueProposition.slice(0, MAX_FIELD_LENGTH),
  });
}
