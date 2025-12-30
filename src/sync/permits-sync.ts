import { PermitRecord } from '../parsers/permits.js';
import {
  diffPermits,
  upsertPermitState,
  updatePermitThreefoldIds,
  createSyncLog,
  completeSyncLog,
  PermitStateChange,
  isTableEmpty,
} from '../state/tracker.js';
import {
  initializePermitCaches,
  convertPermitRecordToApiRequest,
  createPermit,
  updatePermit,
  getPermitByNumber,
  bulkCreatePermits,
  clearPermitCaches,
} from './threefold-permits.js';
import { config } from '../config.js';

/**
 * Log a summary of all changes before processing begins.
 */
function logChangesSummary(changes: PermitStateChange[]): void {
  const newRecords = changes.filter(c => c.isNew);
  const updatedRecords = changes.filter(c => !c.isNew);
  const dryRun = !config.permitUpdatesEnabled;

  console.log('');
  console.log('┌' + '─'.repeat(78) + '┐');
  if (dryRun) {
    console.log('│ PERMITS SYNC SUMMARY [DRY RUN - updates disabled]' + ' '.repeat(28) + '│');
  } else {
    console.log('│ PERMITS SYNC SUMMARY' + ' '.repeat(57) + '│');
  }
  console.log('├' + '─'.repeat(78) + '┤');
  const createAction = dryRun ? '(would create in Threefold)' : '(will create in Threefold)';
  const updateAction = dryRun ? '(would update in Threefold)' : '(will update in Threefold)';
  console.log(`│ New permits:         ${newRecords.length.toString().padEnd(5)} ${createAction}` + ' '.repeat(createAction === '(would create in Threefold)' ? 23 : 24) + '│');
  console.log(`│ Changed permits:     ${updatedRecords.length.toString().padEnd(5)} ${updateAction}` + ' '.repeat(updateAction === '(would update in Threefold)' ? 23 : 24) + '│');
  console.log('├' + '─'.repeat(78) + '┤');

  // Sample of new permits
  if (newRecords.length > 0) {
    console.log('│ NEW PERMITS (first 10):' + ' '.repeat(54) + '│');
    for (const c of newRecords.slice(0, 10)) {
      const line = `  ${c.record.permitNo} | ${c.record.permitType} | ${c.record.status}`;
      console.log('│' + line.substring(0, 77).padEnd(78) + '│');
      const addrLine = `    @ ${c.record.siteAddress}`;
      console.log('│' + addrLine.substring(0, 77).padEnd(78) + '│');
    }
    if (newRecords.length > 10) {
      console.log(`│  ... and ${newRecords.length - 10} more new permits` + ' '.repeat(45) + '│');
    }
    console.log('├' + '─'.repeat(78) + '┤');
  }

  // Sample of updated permits
  if (updatedRecords.length > 0) {
    console.log('│ CHANGED PERMITS (first 10):' + ' '.repeat(50) + '│');
    for (const c of updatedRecords.slice(0, 10)) {
      const line = `  ${c.record.permitNo} | ${c.record.status}`;
      console.log('│' + line.substring(0, 77).padEnd(78) + '│');
      const addrLine = `    @ ${c.record.siteAddress}`;
      console.log('│' + addrLine.substring(0, 77).padEnd(78) + '│');
    }
    if (updatedRecords.length > 10) {
      console.log(`│  ... and ${updatedRecords.length - 10} more changed permits` + ' '.repeat(41) + '│');
    }
  }

  console.log('└' + '─'.repeat(78) + '┘');
  console.log('');
}

/**
 * Process a single permit change (new or updated).
 * Includes retry logic for stale cache errors.
 */
async function processPermitChange(
  change: PermitStateChange,
  retryCount = 0
): Promise<{
  threefoldPermitId: number;
  typeId: number;
  subtypeId: number | null;
  statusId: number | null;
}> {
  const { record, isNew, threefoldPermitId } = change;

  try {
    // Convert record to API request (resolves type/subtype/status IDs)
    const { request, typeId, subtypeId, statusId } = await convertPermitRecordToApiRequest(record);

    if (isNew) {
      // Check if permit already exists in Threefold (edge case: cached ID missing)
      const existing = await getPermitByNumber(record.permitNo);
      if (existing) {
        // Permit exists, update it instead
        console.log(`[PERMIT] ${record.permitNo} already exists in Threefold (ID: ${existing.id}), updating...`);
        const updated = await updatePermit(existing.id, request);
        return { threefoldPermitId: updated.id, typeId, subtypeId, statusId };
      }

      // Try to create new permit, fallback to update if already exists
      try {
        const created = await createPermit(request);
        console.log(`[PERMIT] Created: ${record.permitNo} → Threefold ID: ${created.id}`);
        return { threefoldPermitId: created.id, typeId, subtypeId, statusId };
      } catch (err) {
        // If permit already exists (constraint violation), try to update instead
        const errorMsg = err instanceof Error ? err.message : '';
        if (errorMsg.includes('already exists') || errorMsg.includes('constraint')) {
          console.log(`[PERMIT] ${record.permitNo} already exists (caught on create), updating by permit_no...`);
          const updated = await updatePermit(record.permitNo, request);
          return { threefoldPermitId: updated.id, typeId, subtypeId, statusId };
        }
        throw err;
      }
    } else {
      // Update existing permit
      const permitIdToUpdate = threefoldPermitId || record.permitNo;
      const updated = await updatePermit(permitIdToUpdate, request);
      console.log(`[PERMIT] Updated: ${record.permitNo} (ID: ${updated.id})`);
      return { threefoldPermitId: updated.id, typeId, subtypeId, statusId };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : '';

    // If type/subtype/status ID doesn't exist, refresh cache and retry once
    if (retryCount === 0 && (
      errorMsg.includes('does not exist') ||
      errorMsg.includes('type_id') ||
      errorMsg.includes('subtype_id') ||
      errorMsg.includes('status_id')
    )) {
      console.log(`[PERMIT] ${record.permitNo}: Stale cache detected, refreshing and retrying...`);
      clearPermitCaches();
      await initializePermitCaches();
      return processPermitChange(change, retryCount + 1);
    }

    throw err;
  }
}

/**
 * Bulk process new permits for initial sync.
 * Processes in batches of 100 for API calls (within 1000 record processing batches).
 */
async function bulkProcessNewPermits(
  records: PermitRecord[],
  onProgress?: (processed: number, total: number) => void
): Promise<{ created: number; failed: number; errors: string[] }> {
  const BATCH_SIZE = 100; // API batch size
  let totalCreated = 0;
  let totalFailed = 0;
  const allErrors: string[] = [];

  console.log(`[SYNC] Bulk creating ${records.length} permits in batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    console.log(`[SYNC] Processing batch ${batchNum}/${totalBatches} (${batch.length} permits)...`);

    // Convert all records in batch
    const requests = await Promise.all(
      batch.map(async (record) => {
        try {
          const { request } = await convertPermitRecordToApiRequest(record);
          return { request, permitNo: record.permitNo, success: true };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          return { request: null, permitNo: record.permitNo, success: false, error: errorMsg };
        }
      })
    );

    // Filter out conversion failures
    const successfulConversions = requests.filter(r => r.success && r.request);
    const conversionFailures = requests.filter(r => !r.success);

    if (conversionFailures.length > 0) {
      for (const failure of conversionFailures) {
        allErrors.push(`${failure.permitNo}: ${failure.error || 'Conversion failed'}`);
      }
      totalFailed += conversionFailures.length;
    }

    if (successfulConversions.length === 0) {
      continue;
    }

    // Bulk create (no batch_id - API requires valid UUID which we don't need for tracking)
    try {
      const result = await bulkCreatePermits(
        successfulConversions.map(r => r.request!)
      );

      totalCreated += result.created;
      totalFailed += result.failed;

      if (result.errors.length > 0) {
        for (const error of result.errors) {
          allErrors.push(`${error.permit_no || `Index ${error.index}`}: ${error.error}`);
        }
      }

      console.log(`[SYNC] Batch ${batchNum}: created ${result.created}, failed ${result.failed}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Bulk create failed';
      console.error(`[SYNC] Batch ${batchNum} failed: ${errorMsg}`);
      allErrors.push(`Batch ${batchNum}: ${errorMsg}`);
      totalFailed += successfulConversions.length;
    }

    if (onProgress) {
      onProgress(i + batch.length, records.length);
    }

    // Rate limit between batches
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { created: totalCreated, failed: totalFailed, errors: allErrors };
}

/**
 * Process permits sync.
 *
 * 1. Check if initial sync (empty permit_state table)
 *    - If initial: bulk import all permits to Threefold
 * 2. Diff incoming records against stored state
 * 3. For each change: create or update permit in Threefold
 * 4. Update stored state
 */
/**
 * Sort permits by permit number descending (latest first).
 * Permit numbers like B25-00123 contain the year, so descending order = newest first.
 */
function sortPermitsLatestFirst(records: PermitRecord[]): PermitRecord[] {
  return [...records].sort((a, b) => {
    // Sort descending by permit number (B25 > B24 > B17, etc.)
    return b.permitNo.localeCompare(a.permitNo);
  });
}

export async function processPermitsSync(records: PermitRecord[]): Promise<void> {
  const syncLogId = await createSyncLog('permits');
  let errors = 0;
  let changed = 0;

  try {
    // Sort permits so latest (newest) are processed first
    const sortedRecords = sortPermitsLatestFirst(records);
    console.log(`[SYNC] Starting permits sync with ${sortedRecords.length} records (sorted latest first)`);

    // Initialize caches (types, statuses) from Threefold
    await initializePermitCaches();

    // Check if this is initial sync (empty table)
    const isInitialSync = await isTableEmpty('permit_state');
    const dryRun = !config.permitUpdatesEnabled;

    if (isInitialSync) {
      console.log(`[SYNC] Initial sync detected - bulk importing ${sortedRecords.length} permits...`);

      if (dryRun) {
        console.log('[SYNC] DRY RUN: Skipping Threefold API calls, only updating local state');
        await upsertPermitState(sortedRecords);
        await completeSyncLog(syncLogId, sortedRecords.length, sortedRecords.length, 0);
        console.log(`[SYNC] Initial sync complete (dry run): ${sortedRecords.length} permits recorded in local state`);
        return;
      }

      // Process in batches of 1000 records
      const PROCESSING_BATCH_SIZE = 1000;
      const totalBatches = Math.ceil(sortedRecords.length / PROCESSING_BATCH_SIZE);

      for (let batchIdx = 0; batchIdx < sortedRecords.length; batchIdx += PROCESSING_BATCH_SIZE) {
        const batch = sortedRecords.slice(batchIdx, batchIdx + PROCESSING_BATCH_SIZE);
        const batchNum = Math.floor(batchIdx / PROCESSING_BATCH_SIZE) + 1;

        console.log(`\n[SYNC] ===== Processing batch ${batchNum}/${totalBatches} (${batch.length} permits) =====`);

        // Bulk import this batch
        const result = await bulkProcessNewPermits(batch);
        changed += result.created;
        errors += result.failed;

        if (result.errors.length > 0) {
          console.warn(`[SYNC] ${result.errors.length} errors in batch ${batchNum}:`);
          for (const err of result.errors.slice(0, 5)) {
            console.warn(`  - ${err}`);
          }
          if (result.errors.length > 5) {
            console.warn(`  ... and ${result.errors.length - 5} more errors`);
          }
        }

        // Update local state for this batch
        await upsertPermitState(batch);

        console.log(`[SYNC] Batch ${batchNum} complete: ${result.created} created, ${result.failed} failed`);
        console.log(`[SYNC] Running total: ${changed} created, ${errors} errors`);

        // Clear caches between batches to free memory
        clearPermitCaches();
      }

      await completeSyncLog(syncLogId, sortedRecords.length, changed, errors);
      console.log(`\n[SYNC] Initial sync complete: ${sortedRecords.length} total, ${changed} created, ${errors} errors`);
      return;
    }

    // Incremental sync - find changes
    const changes = await diffPermits(sortedRecords);
    console.log(`[SYNC] Found ${changes.length} changes to process`);

    if (changes.length === 0) {
      console.log(`[SYNC] No changes detected, skipping processing`);
      // Still update state to refresh last_seen_at
      await upsertPermitState(sortedRecords);
      await completeSyncLog(syncLogId, sortedRecords.length, 0, 0);
      return;
    }

    // Log summary
    logChangesSummary(changes);

    if (dryRun) {
      console.log('[SYNC] DRY RUN: Skipping Threefold API calls');
      await upsertPermitState(sortedRecords);
      await completeSyncLog(syncLogId, sortedRecords.length, changes.length, 0);
      console.log(`[SYNC] Permits sync complete (dry run): ${sortedRecords.length} total, ${changes.length} would have changed`);
      return;
    }

    // Process each change
    for (const change of changes) {
      try {
        const result = await processPermitChange(change);

        // Update Threefold IDs in local state
        await updatePermitThreefoldIds(
          change.record.permitNo,
          result.threefoldPermitId,
          result.typeId,
          result.subtypeId,
          result.statusId
        );

        changed++;
      } catch (err) {
        console.error(`[SYNC] Error processing permit ${change.record.permitNo}:`, err);
        errors++;
      }
    }

    // Update stored state for all records
    console.log(`[SYNC] Updating state for ${sortedRecords.length} records...`);
    await upsertPermitState(sortedRecords);
    console.log(`[SYNC] State updated successfully`);

    await completeSyncLog(syncLogId, sortedRecords.length, changed, errors);
    console.log(`[SYNC] Permits sync complete: ${sortedRecords.length} total, ${changed} processed, ${errors} errors`);

    // Clear caches to free memory
    clearPermitCaches();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    // Clear caches even on error
    clearPermitCaches();
    await completeSyncLog(syncLogId, records.length, changed, errors, errorMessage);
    throw err;
  }
}
