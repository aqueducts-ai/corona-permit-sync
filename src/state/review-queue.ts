import pg from 'pg';
import { config } from '../config.js';
import type { ViolationRecord } from '../parsers/violations.js';
import type { CandidateTicket, ReviewReason, ReviewQueueItem } from '../matching/types.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
});

/**
 * Add a violation to the review queue for manual matching.
 */
export async function queueForReview(
  violation: ViolationRecord,
  candidates: CandidateTicket[],
  reason: ReviewReason
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO review_queue (external_id, violation_data, candidate_tickets, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      violation.externalId,
      JSON.stringify(violation),
      candidates.length > 0 ? JSON.stringify(candidates) : null,
      reason,
    ]
  );
  console.log(`[REVIEW] Queued: ${violation.caseNo} (${reason}) - ID #${result.rows[0].id}`);
  return result.rows[0].id;
}

/**
 * Get pending items from the review queue.
 */
export async function getReviewQueue(limit = 50): Promise<ReviewQueueItem[]> {
  const result = await pool.query(
    `SELECT
      id,
      external_id,
      violation_data,
      candidate_tickets,
      reason,
      status,
      resolved_ticket_id,
      resolved_by,
      resolved_at,
      created_at
     FROM review_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(row => ({
    id: row.id,
    externalId: row.external_id,
    violationData: row.violation_data as ViolationRecord,
    candidateTickets: row.candidate_tickets as CandidateTicket[] | null,
    reason: row.reason as ReviewReason,
    status: row.status as 'pending' | 'resolved' | 'skipped',
    resolvedTicketId: row.resolved_ticket_id,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  }));
}

/**
 * Resolve a review queue item by assigning a ticket.
 */
export async function resolveReviewItem(
  id: number,
  ticketId: number | null,
  resolvedBy: string
): Promise<void> {
  const status = ticketId ? 'resolved' : 'skipped';
  await pool.query(
    `UPDATE review_queue SET
      status = $2,
      resolved_ticket_id = $3,
      resolved_by = $4,
      resolved_at = NOW()
     WHERE id = $1`,
    [id, status, ticketId, resolvedBy]
  );
}

/**
 * Get review queue statistics.
 */
export async function getReviewStats(): Promise<{
  pending: number;
  resolved: number;
  skipped: number;
}> {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
      COUNT(*) FILTER (WHERE status = 'skipped') as skipped
    FROM review_queue
  `);

  return {
    pending: parseInt(result.rows[0].pending, 10),
    resolved: parseInt(result.rows[0].resolved, 10),
    skipped: parseInt(result.rows[0].skipped, 10),
  };
}

/**
 * Check if a violation is already in the review queue.
 */
export async function isInReviewQueue(externalId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM review_queue WHERE external_id = $1 AND status = 'pending' LIMIT 1`,
    [externalId]
  );
  return result.rows.length > 0;
}
