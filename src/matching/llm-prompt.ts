import type { ViolationRecord } from '../parsers/violations.js';
import type { CandidateTicket, LLMMatchResult, MatchConfidence } from './types.js';

export const SYSTEM_PROMPT = `You are a ticket matching assistant for a municipal code enforcement system. Your job is to match TrakIT violation records to Threefold tickets based on location and violation type.

Rules:
1. Location is the primary matching criteria - addresses should be the same or very close
2. Violation type should reasonably match the ticket description or title
3. Dates should be plausible (ticket created before or around the violation date)
4. If multiple tickets match equally well, prefer the most recent one
5. If no ticket is a good match, return null for ticketId

Respond in JSON format only. No additional text.`;

/**
 * Build the user prompt for ticket matching.
 */
export function buildMatchingPrompt(
  violation: ViolationRecord,
  candidates: CandidateTicket[]
): string {
  const fullAddress = [
    violation.siteAddress,
    violation.siteCity,
    violation.siteState,
    violation.siteZip,
  ]
    .filter(Boolean)
    .join(', ');

  const candidatesForPrompt = candidates.map(c => ({
    id: c.ticketId,
    title: c.title,
    description: c.description?.slice(0, 200) || '',
    address: c.address,
    type: c.ticketType,
    status: c.status,
    created: c.createdAt?.split('T')[0] || '',
  }));

  return `Match this violation to the best ticket:

VIOLATION:
- Case: ${violation.caseNo}
- Type: ${violation.violationType}
- Status: ${violation.violationStatus}
- Address: ${fullAddress}
- Date Observed: ${violation.dateObserved}
- Case Type: ${violation.caseType}${violation.caseSubType ? ` / ${violation.caseSubType}` : ''}

CANDIDATE TICKETS:
${JSON.stringify(candidatesForPrompt, null, 2)}

Respond with JSON only:
{"ticketId": <number or null>, "confidence": "high" | "medium" | "low", "reasoning": "<brief explanation>"}`;
}

/**
 * Parse and validate the LLM response.
 */
export function parseMatchingResponse(
  response: string,
  candidateIds: number[]
): LLMMatchResult | null {
  try {
    // Try to extract JSON from the response (handle markdown code blocks)
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    // Validate ticketId
    const ticketId = parsed.ticketId;
    if (ticketId !== null && !candidateIds.includes(ticketId)) {
      console.warn(`LLM returned invalid ticket ID: ${ticketId}`);
      return null;
    }

    // Validate confidence
    const validConfidences: MatchConfidence[] = ['high', 'medium', 'low'];
    const confidence = validConfidences.includes(parsed.confidence)
      ? (parsed.confidence as MatchConfidence)
      : 'low';

    return {
      ticketId: ticketId ?? null,
      confidence,
      reasoning: String(parsed.reasoning || ''),
    };
  } catch (err) {
    console.error('Failed to parse LLM response:', err);
    console.error('Raw response:', response);
    return null;
  }
}
