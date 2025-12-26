import type { ViolationRecord } from '../parsers/violations.js';

/**
 * Candidate ticket returned from Threefold's location API.
 */
export interface CandidateTicket {
  ticketId: number;
  title: string;
  description: string;
  address: string;
  lat: number;
  lng: number;
  status: string;
  createdAt: string;
  ticketType: string;
  externalId?: string;
}

/**
 * Method used to match a violation to a ticket.
 */
export type MatchMethod = 'cached' | 'external_id' | 'llm' | 'manual' | 'none';

/**
 * Confidence level from LLM matching.
 */
export type MatchConfidence = 'high' | 'medium' | 'low';

/**
 * Result of attempting to match a violation to a ticket.
 */
export interface MatchResult {
  ticketId: number | null;
  matchMethod: MatchMethod;
  confidence?: MatchConfidence;
  reasoning?: string;
  needsReview: boolean;
}

/**
 * Parsed response from the LLM matching call.
 */
export interface LLMMatchResult {
  ticketId: number | null;
  confidence: MatchConfidence;
  reasoning: string;
}

/**
 * Reason why a violation was queued for manual review.
 */
export type ReviewReason =
  | 'no_candidates'
  | 'low_confidence'
  | 'multiple_matches'
  | 'llm_parse_error'
  | 'api_error';

/**
 * Item in the review queue for manual matching.
 */
export interface ReviewQueueItem {
  id: number;
  externalId: string;
  violationData: ViolationRecord;
  candidateTickets: CandidateTicket[] | null;
  reason: ReviewReason;
  status: 'pending' | 'resolved' | 'skipped';
  resolvedTicketId: number | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/**
 * Request body for Threefold's location-based ticket search.
 */
export interface TicketsByLocationRequest {
  address?: string;
  lat?: number;
  lng?: number;
  radius: number;
  include_resolved?: boolean;
  from_date?: string;
  to_date?: string;
  status_types?: string[];
  limit?: number;
  gis_intersections?: string[];
}

/**
 * Entry in the match_log table for auditing.
 */
export interface MatchLogEntry {
  externalId: string;
  matchMethod: MatchMethod;
  candidateCount: number;
  selectedTicketId: number | null;
  confidence: MatchConfidence | null;
  llmReasoning: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}
