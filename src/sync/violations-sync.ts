import { ViolationRecord } from '../parsers/violations.js';
import {
  diffViolations,
  upsertViolationState,
  createSyncLog,
  completeSyncLog,
  ViolationStateChange,
  isTableEmpty,
} from '../state/tracker.js';
import { closeTicket, addTicketComment } from './threefold.js';
import { matchViolationToTicket } from '../matching/ticket-matcher.js';
import { config } from '../config.js';

/**
 * Violation statuses that should close the linked ticket.
 */
const CLOSE_STATUSES = ['COMPLIED', 'UNFOUNDED'];

/**
 * Log a clear summary of all changes before processing begins.
 */
function logChangesSummary(changes: ViolationStateChange[]): void {
  const newRecords = changes.filter(c => c.isNew);
  const statusChanges = changes.filter(c => !c.isNew);
  const willClose = statusChanges.filter(c => CLOSE_STATUSES.includes(c.newStatus));
  const willComment = statusChanges.filter(c => !CLOSE_STATUSES.includes(c.newStatus));
  const dryRun = !config.ticketUpdatesEnabled;

  console.log('');
  console.log('┌' + '─'.repeat(78) + '┐');
  if (dryRun) {
    console.log('│ CHANGES SUMMARY [DRY RUN - ticket updates disabled]' + ' '.repeat(25) + '│');
  } else {
    console.log('│ CHANGES SUMMARY' + ' '.repeat(62) + '│');
  }
  console.log('├' + '─'.repeat(78) + '┤');
  console.log(`│ New violations:      ${newRecords.length.toString().padEnd(5)} (will record state only)` + ' '.repeat(27) + '│');
  const ticketAction = dryRun ? '(would update tickets)' : '(will update tickets)';
  console.log(`│ Status changes:      ${statusChanges.length.toString().padEnd(5)} ${ticketAction}` + ' '.repeat(ticketAction === '(would update tickets)' ? 27 : 28) + '│');
  console.log(`│   → ${dryRun ? 'Would' : 'Will'} close:      ${willClose.length.toString().padEnd(5)} (COMPLIED/UNFOUNDED)` + ' '.repeat(dryRun ? 27 : 28) + '│');
  console.log(`│   → ${dryRun ? 'Would' : 'Will'} comment:    ${willComment.length.toString().padEnd(5)} (other status changes)` + ' '.repeat(dryRun ? 24 : 25) + '│');
  console.log('├' + '─'.repeat(78) + '┤');

  // List new violations
  if (newRecords.length > 0) {
    console.log('│ NEW VIOLATIONS:' + ' '.repeat(62) + '│');
    for (const c of newRecords) {
      const line = `  ${c.record.caseNo || '(no case)'} | ${c.record.violationType} | ${c.newStatus}`;
      console.log('│' + line.substring(0, 77).padEnd(78) + '│');
      const addrLine = `    @ ${c.record.siteAddress}`;
      console.log('│' + addrLine.substring(0, 77).padEnd(78) + '│');
    }
    console.log('├' + '─'.repeat(78) + '┤');
  }

  // List status changes
  if (statusChanges.length > 0) {
    console.log('│ STATUS CHANGES:' + ' '.repeat(62) + '│');
    for (const c of statusChanges) {
      const action = CLOSE_STATUSES.includes(c.newStatus) ? '[CLOSE]' : '[COMMENT]';
      const line = `  ${action} ${c.record.caseNo || '(no case)'} | ${c.previousStatus} → ${c.newStatus}`;
      console.log('│' + line.substring(0, 77).padEnd(78) + '│');
      const addrLine = `    @ ${c.record.siteAddress}`;
      console.log('│' + addrLine.substring(0, 77).padEnd(78) + '│');
    }
  }

  console.log('└' + '─'.repeat(78) + '┘');
  console.log('');
}

/**
 * Process violations sync.
 *
 * 1. Diff incoming records against stored state
 * 2. For status changes to COMPLIED/UNFOUNDED, close linked tickets
 * 3. Update stored state
 */
export async function processViolationsSync(records: ViolationRecord[]): Promise<void> {
  const syncLogId = await createSyncLog('violations');
  let errors = 0;
  let changed = 0;

  try {
    console.log(`[SYNC] Starting violations sync with ${records.length} records`);

    // Check if this is initial sync (empty table)
    const isInitialSync = await isTableEmpty('violation_state');

    if (isInitialSync) {
      // Initial sync - just populate state without verbose logging
      console.log(`[SYNC] Initial sync - populating violation_state table with ${records.length} records...`);
      await upsertViolationState(records);
      await completeSyncLog(syncLogId, records.length, records.length, 0);
      console.log(`[SYNC] Initial sync complete: ${records.length} violations recorded`);
      return;
    }

    // Find changes
    const changes = await diffViolations(records);
    console.log(`[SYNC] Found ${changes.length} changes to process`);

    if (changes.length === 0) {
      console.log(`[SYNC] No changes detected, skipping processing`);
    } else {
      // Log summary of all changes BEFORE processing
      logChangesSummary(changes);
    }

    // Process each change (no per-item logging to avoid rate limits)
    for (const change of changes) {
      try {
        await processViolationChange(change);
        changed++;
      } catch (err) {
        console.error(`[SYNC] Error processing violation ${change.externalId}:`, err);
        errors++;
      }
    }

    // Update stored state for all records
    console.log(`[SYNC] Updating state for ${records.length} records...`);
    try {
      await upsertViolationState(records);
      console.log(`[SYNC] State updated successfully`);
    } catch (upsertErr) {
      console.error(`[SYNC] Failed to upsert state:`, upsertErr);
      throw upsertErr;
    }

    await completeSyncLog(syncLogId, records.length, changed, errors);
    console.log(`[SYNC] Violations sync complete: ${records.length} total, ${changed} processed, ${errors} errors`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await completeSyncLog(syncLogId, records.length, changed, errors, errorMessage);
    throw err;
  }
}

async function processViolationChange(change: ViolationStateChange): Promise<void> {
  const { record, previousStatus, newStatus, isNew } = change;
  const dryRun = !config.ticketUpdatesEnabled;

  // Skip new records - just recording state, no ticket to update
  if (isNew) {
    return;
  }

  // In dry run mode, skip ticket matching and API calls entirely (no logging to avoid rate limits)
  if (dryRun) {
    return;
  }

  // Only log when actually making API calls
  console.log(
    `[VIOLATION] ${record.caseNo} | ${record.violationType} | ${previousStatus} → ${newStatus}`
  );

  // Match violation to a ticket (uses LLM + location API)
  const matchResult = await matchViolationToTicket(record);

  if (!matchResult.ticketId) {
    console.log(`[MATCH] No ticket found (method: ${matchResult.matchMethod}, queued: ${matchResult.needsReview})`);
    return;
  }

  console.log(`[MATCH] Matched → ticket #${matchResult.ticketId} via ${matchResult.matchMethod}${matchResult.confidence ? ` (${matchResult.confidence})` : ''}`);

  // Check if status change should close the ticket
  if (CLOSE_STATUSES.includes(newStatus)) {
    const reason = newStatus === 'COMPLIED'
      ? `Violation marked as COMPLIED in TrakIT (was: ${previousStatus})`
      : `Violation marked as UNFOUNDED in TrakIT (was: ${previousStatus})`;

    console.log(`[ACTION] Closing ticket #${matchResult.ticketId} - ${newStatus}`);
    await closeTicket(matchResult.ticketId, reason);
    console.log(`[ACTION] Ticket closed successfully`);
  } else {
    // Just add a comment for other status changes
    const comment =
      `TrakIT status update: ${previousStatus} → ${newStatus}\n` +
      `Violation: ${record.violationType}\n` +
      `Address: ${record.siteAddress}`;

    console.log(`[ACTION] Adding comment to ticket #${matchResult.ticketId}`);
    await addTicketComment(matchResult.ticketId, comment);
    console.log(`[ACTION] Comment added successfully`);
  }
}
