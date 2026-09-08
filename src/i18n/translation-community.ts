/** Data and wording checks shared by the editor, submission API and review tooling. */
export interface Entry {
  id: string;
  surface: 'app' | 'about';
  key: string;
  sourceEn: string;
  sourceKo: string;
  current: string;
}

export interface ProposalDraft extends Entry {
  locale: string;
  proposed: string;
  reason: string;
  updatedAt: string;
}

/** id is the server suggestion ID; the phrase identity is `${surface}:${key}`. */
export interface Suggestion extends Omit<Entry, 'id'> {
  id: string;
  locale: string;
  proposed: string;
  reason: string;
  author: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  revision: number;
  votes: number;
  voted: boolean;
  owned: boolean;
  outdated: boolean;
  applied: boolean;
}

export interface ApprovedTranslationDraft extends ProposalDraft {
  suggestionId: string;
  reviewRevision: number;
  approvedAt: number;
}

export interface ApprovedTranslationsExport {
  version: 1;
  kind: 'musixquare-approved-translations';
  exportedAt: string;
  drafts: ApprovedTranslationDraft[];
}

export type ProposalIssue = 'empty' | 'unchanged' | 'too-long' | 'placeholders' | 'markup';
export const MAX_TRANSLATION_TEXT_LENGTH = 32_768;

function placeholders(text: string): string {
  return JSON.stringify((text.match(/\{\{[^{}]*\}\}/g) ?? []).sort());
}

// Compare markup as literal tokens, never parse it into a live document. Requiring
// identical tokens also keeps attribute values (including URLs) unchanged.
function markup(text: string): string | null {
  const tokens: string[] = [];
  for (let offset = 0; offset < text.length; offset++) {
    if (text[offset] !== '<' || !/[A-Za-z!/?]/.test(text[offset + 1] ?? '')) continue;
    const token = /^<(?:[^<>"']|"[^"]*"|'[^']*')*>/.exec(text.slice(offset));
    if (!token) return null;
    tokens.push(token[0]);
    offset += token[0].length - 1;
  }
  return JSON.stringify(tokens);
}

/** The server/tool caller must supply a canonical, freshness-checked entry. */
export function validateProposal(entry: Entry, proposed: string): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  if (!proposed.trim()) issues.push('empty');
  if (proposed === entry.current) issues.push('unchanged');
  if (proposed.length > MAX_TRANSLATION_TEXT_LENGTH) return [...issues, 'too-long'];
  if (placeholders(proposed) !== placeholders(entry.sourceEn)) issues.push('placeholders');
  const proposedMarkup = markup(proposed);
  if (proposedMarkup === null || proposedMarkup !== markup(entry.current)) issues.push('markup');
  return issues;
}
