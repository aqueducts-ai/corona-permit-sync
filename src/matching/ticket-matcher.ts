import { config } from '../config.js';
import type { ViolationRecord } from '../parsers/violations.js';
import { findTicketByExternalId, fetchTicketsByLocation, setTicketExternalId } from '../sync/threefold.js';
import { getMatchedTicketId, setMatchedTicketId, logMatchAttempt } from '../state/tracker.js';
import { queueForReview, isInReviewQueue } from '../state/review-queue.js';
import { callOpenAI } from '../llm/openai.js';
import { buildMatchingPrompt, parseMatchingResponse, SYSTEM_PROMPT } from './llm-prompt.js';
import type { MatchResult, CandidateTicket } from './types.js';

/**
 * Subtract days from a date string (YYYY-MM-DD format).
 */
function subtractDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

/**
 * Match a violation to a Threefold ticket.
 *
 * Priority:
 * 1. Check cached match in database (fast path)
 * 2. Try external ID lookup (existing fallback)
 * 3. Use LLM matching with location API
 * 4. Queue for manual review if no confident match
 */
export async function matchViolationToTicket(
  violation: ViolationRecord
): Promise<MatchResult> {
  const startTime = Date.now();

  // 1. Check cached match first (fast path for previously matched violations)
  const cachedTicketId = await getMatchedTicketId(violation.externalId);
  if (cachedTicketId) {
    console.log(`[MATCH] Cache hit → ticket #${cachedTicketId}`);
    return {
      ticketId: cachedTicketId,
      matchMethod: 'cached',
      needsReview: false,
    };
  }

  // 2. Try external ID lookup (existing mechanism, serves as fallback)
  try {
    const exactMatch = await findTicketByExternalId(violation.externalId);
    if (exactMatch) {
      console.log(`[MATCH] External ID match → ticket #${exactMatch.ticketId}`);
      await setMatchedTicketId(violation.externalId, exactMatch.ticketId, 'external_id');
      return {
        ticketId: exactMatch.ticketId,
        matchMethod: 'external_id',
        needsReview: false,
      };
    }
  } catch (err) {
    console.warn(`[MATCH] External ID lookup failed:`, err);
  }

  // 3. Check if LLM matching is enabled
  if (!config.llmMatchingEnabled) {
    console.log(`[MATCH] LLM matching disabled, skipping`);
    return {
      ticketId: null,
      matchMethod: 'none',
      needsReview: true,
    };
  }

  // 4. Fetch candidates by location
  const fullAddress = [
    violation.siteAddress,
    violation.siteCity,
    violation.siteState,
    violation.siteZip,
  ]
    .filter(Boolean)
    .join(', ');

  console.log(`[MATCH] Searching for tickets near: ${fullAddress}`);

  let candidates: CandidateTicket[] = [];
  try {
    candidates = await fetchTicketsByLocation({
      address: fullAddress,
      radius: config.matchingRadiusMeters,
      from_date: subtractDays(violation.dateObserved || new Date().toISOString().split('T')[0], config.matchingLookbackDays),
      include_resolved: false,
      limit: 10,
    });
    console.log(`[MATCH] Found ${candidates.length} candidate tickets within ${config.matchingRadiusMeters}m`);
  } catch (err) {
    console.error(`[MATCH] Location API failed:`, err);
    // Don't queue for review on API errors - let the sync continue
    return {
      ticketId: null,
      matchMethod: 'none',
      needsReview: false, // Will retry on next sync
    };
  }

  // 5. No candidates found
  if (candidates.length === 0) {
    console.log(`[MATCH] No candidates found, queuing for review`);

    // Check if already in review queue
    if (!(await isInReviewQueue(violation.externalId))) {
      await queueForReview(violation, [], 'no_candidates');
    }

    await logMatchAttempt({
      externalId: violation.externalId,
      matchMethod: 'llm',
      candidateCount: 0,
      selectedTicketId: null,
      confidence: null,
      llmReasoning: null,
      promptTokens: null,
      completionTokens: null,
      durationMs: Date.now() - startTime,
    });

    return {
      ticketId: null,
      matchMethod: 'llm',
      needsReview: true,
    };
  }

  // 6. Call LLM to select best match
  console.log(`[LLM] Calling ${config.openaiModel} to match against ${candidates.length} candidates...`);
  const prompt = buildMatchingPrompt(violation, candidates);

  let llmResult;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  try {
    const response = await callOpenAI(prompt, SYSTEM_PROMPT);
    promptTokens = response.promptTokens;
    completionTokens = response.completionTokens;
    console.log(`[LLM] Response received (${promptTokens} prompt + ${completionTokens} completion tokens)`);

    const candidateIds = candidates.map(c => c.ticketId);
    llmResult = parseMatchingResponse(response.content, candidateIds);
  } catch (err) {
    console.error(`[LLM] API call failed:`, err);

    if (!(await isInReviewQueue(violation.externalId))) {
      await queueForReview(violation, candidates, 'api_error');
    }

    return {
      ticketId: null,
      matchMethod: 'llm',
      needsReview: true,
    };
  }

  // 7. Handle parse failure
  if (!llmResult) {
    console.log(`[LLM] Failed to parse response, queuing for review`);

    if (!(await isInReviewQueue(violation.externalId))) {
      await queueForReview(violation, candidates, 'llm_parse_error');
    }

    await logMatchAttempt({
      externalId: violation.externalId,
      matchMethod: 'llm',
      candidateCount: candidates.length,
      selectedTicketId: null,
      confidence: null,
      llmReasoning: 'parse_error',
      promptTokens: promptTokens ?? null,
      completionTokens: completionTokens ?? null,
      durationMs: Date.now() - startTime,
    });

    return {
      ticketId: null,
      matchMethod: 'llm',
      needsReview: true,
    };
  }

  console.log(`[LLM] Decision: ticket #${llmResult.ticketId ?? 'none'} (${llmResult.confidence}) - ${llmResult.reasoning}`);

  // 8. Log the match attempt
  await logMatchAttempt({
    externalId: violation.externalId,
    matchMethod: 'llm',
    candidateCount: candidates.length,
    selectedTicketId: llmResult.ticketId,
    confidence: llmResult.confidence,
    llmReasoning: llmResult.reasoning,
    promptTokens: promptTokens ?? null,
    completionTokens: completionTokens ?? null,
    durationMs: Date.now() - startTime,
  });

  // 9. Handle low confidence or no match
  if (!llmResult.ticketId || llmResult.confidence === 'low') {
    console.log(`[MATCH] Low confidence match, queuing for review`);
    if (!(await isInReviewQueue(violation.externalId))) {
      await queueForReview(violation, candidates, 'low_confidence');
    }

    return {
      ticketId: llmResult.ticketId,
      matchMethod: 'llm',
      confidence: llmResult.confidence,
      reasoning: llmResult.reasoning,
      needsReview: true,
    };
  }

  // 10. Cache the successful match locally
  console.log(`[MATCH] Caching successful match: ${violation.externalId} → ticket #${llmResult.ticketId}`);
  await setMatchedTicketId(
    violation.externalId,
    llmResult.ticketId,
    'llm',
    llmResult.confidence
  );

  // 11. Stamp the ticket in Threefold with our external ID (for future fast lookups)
  try {
    await setTicketExternalId(llmResult.ticketId, violation.externalId);
  } catch (err) {
    // Non-fatal - we still have the local cache
    console.warn(`[MATCH] Failed to stamp ticket with external ID:`, err);
  }

  const durationMs = Date.now() - startTime;
  console.log(`[MATCH] Complete in ${durationMs}ms`);

  return {
    ticketId: llmResult.ticketId,
    matchMethod: 'llm',
    confidence: llmResult.confidence,
    reasoning: llmResult.reasoning,
    needsReview: false,
  };
}
