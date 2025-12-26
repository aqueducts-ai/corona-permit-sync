import { InspectionRecord } from '../parsers/inspections.js';
import {
  diffInspections,
  upsertInspectionState,
  createSyncLog,
  completeSyncLog,
  InspectionStateChange,
  isTableEmpty,
} from '../state/tracker.js';
import { findTicketsByCaseNo, addTicketComment } from './threefold.js';
import { config } from '../config.js';

/**
 * Process inspections sync.
 *
 * 1. Diff incoming records against stored state
 * 2. For new/changed inspections, add comment to linked tickets
 * 3. Update stored state
 */
export async function processInspectionsSync(records: InspectionRecord[]): Promise<void> {
  const syncLogId = await createSyncLog('inspections');
  let errors = 0;
  let changed = 0;

  try {
    console.log(`[SYNC] Processing ${records.length} inspection records...`);

    // Check if this is initial sync (empty table)
    const isInitialSync = await isTableEmpty('inspection_state');

    if (isInitialSync) {
      // Initial sync - just populate state without verbose logging
      console.log(`[SYNC] Initial sync - populating inspection_state table with ${records.length} records...`);
      await upsertInspectionState(records);
      await completeSyncLog(syncLogId, records.length, records.length, 0);
      console.log(`[SYNC] Initial sync complete: ${records.length} inspections recorded`);
      return;
    }

    // Find changes
    const changes = await diffInspections(records);
    console.log(`[SYNC] Found ${changes.length} changes`);

    // Process each change
    for (const change of changes) {
      try {
        await processInspectionChange(change);
        changed++;
      } catch (err) {
        console.error(`[SYNC] Error processing inspection ${change.uniqueKey}:`, err);
        errors++;
      }
    }

    // Update stored state for all records
    await upsertInspectionState(records);

    await completeSyncLog(syncLogId, records.length, changed, errors);
    console.log(`[SYNC] Inspections sync complete: ${records.length} total, ${changed} changed, ${errors} errors`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await completeSyncLog(syncLogId, records.length, changed, errors, errorMessage);
    throw err;
  }
}

async function processInspectionChange(change: InspectionStateChange): Promise<void> {
  const { record, previousResult, newResult, isNew } = change;
  const dryRun = !config.ticketUpdatesEnabled;

  // In dry run mode, skip ticket lookups and API calls (no logging to avoid rate limits)
  if (dryRun) {
    return;
  }

  // Only log when actually making API calls
  console.log(
    `[INSPECTION] ${record.caseNo} (${record.inspectionType}): ` +
    `${isNew ? `NEW - ${newResult}` : `${previousResult} → ${newResult}`}`
  );

  // Find tickets linked to this case
  const tickets = await findTicketsByCaseNo(record.caseNo);
  if (tickets.length === 0) {
    console.log(`  No linked tickets found for case: ${record.caseNo}`);
    return;
  }

  console.log(`  Found ${tickets.length} linked ticket(s)`);

  // Build comment
  const comment = buildInspectionComment(record, previousResult, isNew);

  // Add comment to all linked tickets
  for (const ticket of tickets) {
    try {
      console.log(`  Adding comment to ticket ${ticket.ticketId}`);
      await addTicketComment(ticket.ticketId, comment);
    } catch (err) {
      console.error(`  Failed to add comment to ticket ${ticket.ticketId}:`, err);
    }
  }
}

function buildInspectionComment(
  record: InspectionRecord,
  previousResult: string | null,
  isNew: boolean
): string {
  const lines = [
    `**TrakIT Inspection ${isNew ? 'Recorded' : 'Updated'}**`,
    '',
    `**Type:** ${record.inspectionType}`,
    `**Result:** ${record.result}${previousResult ? ` (was: ${previousResult})` : ''}`,
    `**Inspector:** ${record.inspector || 'N/A'}`,
    `**Scheduled:** ${record.scheduledDate || 'N/A'}`,
    `**Completed:** ${record.completedDate || 'Pending'}`,
  ];

  if (record.remarks) {
    lines.push('', `**Remarks:** ${record.remarks}`);
  }

  if (record.notes) {
    lines.push('', `**Notes:** ${record.notes}`);
  }

  return lines.join('\n');
}
