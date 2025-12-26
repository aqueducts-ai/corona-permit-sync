import pg from 'pg';
import { config } from '../config.js';
import { ViolationRecord } from '../parsers/violations.js';
import { InspectionRecord } from '../parsers/inspections.js';
import type { MatchMethod, MatchConfidence, MatchLogEntry } from '../matching/types.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
});

/**
 * Initialize the database schema.
 */
export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    // Core tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS violation_state (
        external_id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        case_no TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        violation_status TEXT NOT NULL,
        date_observed TEXT,
        site_address TEXT,
        raw_data JSONB,
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_violation_state_case_no ON violation_state(case_no);
      CREATE INDEX IF NOT EXISTS idx_violation_state_status ON violation_state(violation_status);

      CREATE TABLE IF NOT EXISTS inspection_state (
        unique_key TEXT PRIMARY KEY,
        case_no TEXT NOT NULL,
        inspection_type TEXT NOT NULL,
        result TEXT NOT NULL,
        scheduled_date TEXT,
        completed_date TEXT,
        inspector TEXT,
        raw_data JSONB,
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_inspection_state_case_no ON inspection_state(case_no);
      CREATE INDEX IF NOT EXISTS idx_inspection_state_result ON inspection_state(result);

      CREATE TABLE IF NOT EXISTS sync_log (
        id SERIAL PRIMARY KEY,
        sync_type TEXT NOT NULL,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        total_records INTEGER DEFAULT 0,
        changed_records INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        error_message TEXT,
        metadata JSONB
      );
    `);

    // Migration: Add LLM matching columns to violation_state
    await client.query(`
      ALTER TABLE violation_state
        ADD COLUMN IF NOT EXISTS matched_ticket_id INTEGER,
        ADD COLUMN IF NOT EXISTS match_method TEXT,
        ADD COLUMN IF NOT EXISTS match_confidence TEXT,
        ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_violation_state_matched_ticket ON violation_state(matched_ticket_id);
    `);

    // Review queue for manual matching
    await client.query(`
      CREATE TABLE IF NOT EXISTS review_queue (
        id SERIAL PRIMARY KEY,
        external_id TEXT NOT NULL,
        violation_data JSONB NOT NULL,
        candidate_tickets JSONB,
        reason TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        resolved_ticket_id INTEGER,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
      CREATE INDEX IF NOT EXISTS idx_review_queue_external_id ON review_queue(external_id);
    `);

    // Match log for auditing LLM matching decisions
    await client.query(`
      CREATE TABLE IF NOT EXISTS match_log (
        id SERIAL PRIMARY KEY,
        external_id TEXT NOT NULL,
        match_method TEXT NOT NULL,
        candidate_count INTEGER,
        selected_ticket_id INTEGER,
        confidence TEXT,
        llm_reasoning TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        duration_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_match_log_external_id ON match_log(external_id);
    `);

    console.log('Database schema initialized');
  } finally {
    client.release();
  }
}

// ============ Violations State ============

export interface ViolationStateChange {
  externalId: string;
  record: ViolationRecord;
  previousStatus: string | null;
  newStatus: string;
  isNew: boolean;
}

/**
 * Compare violations against stored state and return changes.
 */
export async function diffViolations(records: ViolationRecord[]): Promise<ViolationStateChange[]> {
  // Sort by external_id then by status to ensure deterministic dedup regardless of CSV row order
  const sorted = [...records].sort((a, b) => {
    const idCmp = a.externalId.localeCompare(b.externalId);
    if (idCmp !== 0) return idCmp;
    return a.violationStatus.localeCompare(b.violationStatus);
  });

  // Deduplicate by external_id (last occurrence after sort wins - deterministic)
  const deduped = new Map<string, ViolationRecord>();
  for (const record of sorted) {
    deduped.set(record.externalId, record);
  }
  const uniqueRecords = Array.from(deduped.values());

  const client = await pool.connect();
  try {
    const changes: ViolationStateChange[] = [];

    // Get all current states in one query
    const externalIds = uniqueRecords.map(r => r.externalId);
    const result = await client.query(
      `SELECT external_id, violation_status FROM violation_state WHERE external_id = ANY($1)`,
      [externalIds]
    );

    const currentStates = new Map<string, string>();
    for (const row of result.rows) {
      currentStates.set(row.external_id, row.violation_status);
    }

    // Find changes
    for (const record of uniqueRecords) {
      const currentStatus = currentStates.get(record.externalId);

      if (currentStatus === undefined) {
        // New record
        changes.push({
          externalId: record.externalId,
          record,
          previousStatus: null,
          newStatus: record.violationStatus,
          isNew: true,
        });
      } else if (currentStatus !== record.violationStatus) {
        // Status changed
        changes.push({
          externalId: record.externalId,
          record,
          previousStatus: currentStatus,
          newStatus: record.violationStatus,
          isNew: false,
        });
      }
    }

    return changes;
  } finally {
    client.release();
  }
}

/**
 * Update stored violation state.
 * Uses multi-row INSERT for optimal write performance.
 */
export async function upsertViolationState(records: ViolationRecord[]): Promise<void> {
  if (records.length === 0) return;

  // Sort by external_id then by status to ensure deterministic dedup regardless of CSV row order
  const sorted = [...records].sort((a, b) => {
    const idCmp = a.externalId.localeCompare(b.externalId);
    if (idCmp !== 0) return idCmp;
    return a.violationStatus.localeCompare(b.violationStatus);
  });

  // Deduplicate by external_id (last occurrence after sort wins - deterministic)
  const deduped = new Map<string, ViolationRecord>();
  for (const record of sorted) {
    deduped.set(record.externalId, record);
  }
  const uniqueRecords = Array.from(deduped.values());

  if (uniqueRecords.length !== records.length) {
    console.log(`[DB] Deduplicated ${records.length} → ${uniqueRecords.length} records (${records.length - uniqueRecords.length} duplicates)`);
  }

  const BATCH_SIZE = 1000;
  const client = await pool.connect();
  const totalBatches = Math.ceil(uniqueRecords.length / BATCH_SIZE);
  console.log(`[DB] Upserting ${uniqueRecords.length} violation records in ${totalBatches} batches...`);

  try {
    for (let i = 0; i < uniqueRecords.length; i += BATCH_SIZE) {
      const batch = uniqueRecords.slice(i, i + BATCH_SIZE);

      // Build multi-row VALUES clause
      const values: unknown[] = [];
      const valuePlaceholders: string[] = [];

      batch.forEach((record, idx) => {
        const offset = idx * 8;
        valuePlaceholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW())`
        );
        values.push(
          record.externalId,
          record.activityId,
          record.caseNo,
          record.violationType,
          record.violationStatus,
          record.dateObserved,
          record.siteAddress,
          JSON.stringify(record)
        );
      });

      const query = `
        INSERT INTO violation_state
          (external_id, activity_id, case_no, violation_type, violation_status, date_observed, site_address, raw_data, last_seen_at)
        VALUES ${valuePlaceholders.join(', ')}
        ON CONFLICT (external_id) DO UPDATE SET
          violation_status = EXCLUDED.violation_status,
          raw_data = EXCLUDED.raw_data,
          last_seen_at = NOW()
      `;

      await client.query(query, values);
    }

    console.log(`[DB] Upserted ${uniqueRecords.length} violation records successfully`);
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

// ============ Inspections State ============

export interface InspectionStateChange {
  uniqueKey: string;
  record: InspectionRecord;
  previousResult: string | null;
  newResult: string;
  isNew: boolean;
}

/**
 * Check if a state table is empty (for detecting initial sync).
 */
export async function isTableEmpty(table: 'violation_state' | 'inspection_state'): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
    return result.rows.length === 0;
  } finally {
    client.release();
  }
}

/**
 * Compare inspections against stored state and return changes.
 */
export async function diffInspections(records: InspectionRecord[]): Promise<InspectionStateChange[]> {
  // Sort by unique_key then by result to ensure deterministic dedup regardless of CSV row order
  const sorted = [...records].sort((a, b) => {
    const keyCmp = a.uniqueKey.localeCompare(b.uniqueKey);
    if (keyCmp !== 0) return keyCmp;
    return a.result.localeCompare(b.result);
  });

  // Deduplicate by unique_key (last occurrence after sort wins - deterministic)
  const deduped = new Map<string, InspectionRecord>();
  for (const record of sorted) {
    deduped.set(record.uniqueKey, record);
  }
  const uniqueRecords = Array.from(deduped.values());

  const client = await pool.connect();
  try {
    const changes: InspectionStateChange[] = [];

    // Get all current states in one query
    const uniqueKeys = uniqueRecords.map(r => r.uniqueKey);
    const result = await client.query(
      `SELECT unique_key, result FROM inspection_state WHERE unique_key = ANY($1)`,
      [uniqueKeys]
    );

    const currentStates = new Map<string, string>();
    for (const row of result.rows) {
      currentStates.set(row.unique_key, row.result);
    }

    // Find changes
    for (const record of uniqueRecords) {
      const currentResult = currentStates.get(record.uniqueKey);

      if (currentResult === undefined) {
        // New inspection
        changes.push({
          uniqueKey: record.uniqueKey,
          record,
          previousResult: null,
          newResult: record.result,
          isNew: true,
        });
      } else if (currentResult !== record.result) {
        // Result changed
        changes.push({
          uniqueKey: record.uniqueKey,
          record,
          previousResult: currentResult,
          newResult: record.result,
          isNew: false,
        });
      }
    }

    return changes;
  } finally {
    client.release();
  }
}

/**
 * Update stored inspection state.
 * Uses multi-row INSERT for optimal write performance.
 */
export async function upsertInspectionState(records: InspectionRecord[]): Promise<void> {
  if (records.length === 0) return;

  // Sort by unique_key then by result to ensure deterministic dedup regardless of CSV row order
  const sorted = [...records].sort((a, b) => {
    const keyCmp = a.uniqueKey.localeCompare(b.uniqueKey);
    if (keyCmp !== 0) return keyCmp;
    return a.result.localeCompare(b.result);
  });

  // Deduplicate by unique_key (last occurrence after sort wins - deterministic)
  const deduped = new Map<string, InspectionRecord>();
  for (const record of sorted) {
    deduped.set(record.uniqueKey, record);
  }
  const uniqueRecords = Array.from(deduped.values());

  if (uniqueRecords.length !== records.length) {
    console.log(`[DB] Deduplicated ${records.length} → ${uniqueRecords.length} inspection records (${records.length - uniqueRecords.length} duplicates)`);
  }

  const BATCH_SIZE = 1000;
  const client = await pool.connect();
  const totalBatches = Math.ceil(uniqueRecords.length / BATCH_SIZE);
  console.log(`[DB] Upserting ${uniqueRecords.length} inspection records in ${totalBatches} batches...`);

  try {
    for (let i = 0; i < uniqueRecords.length; i += BATCH_SIZE) {
      const batch = uniqueRecords.slice(i, i + BATCH_SIZE);

      // Build multi-row VALUES clause
      const values: unknown[] = [];
      const valuePlaceholders: string[] = [];

      batch.forEach((record, idx) => {
        const offset = idx * 8;
        valuePlaceholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW())`
        );
        values.push(
          record.uniqueKey,
          record.caseNo,
          record.inspectionType,
          record.result,
          record.scheduledDate,
          record.completedDate,
          record.inspector,
          JSON.stringify(record)
        );
      });

      const query = `
        INSERT INTO inspection_state
          (unique_key, case_no, inspection_type, result, scheduled_date, completed_date, inspector, raw_data, last_seen_at)
        VALUES ${valuePlaceholders.join(', ')}
        ON CONFLICT (unique_key) DO UPDATE SET
          result = EXCLUDED.result,
          completed_date = EXCLUDED.completed_date,
          raw_data = EXCLUDED.raw_data,
          last_seen_at = NOW()
      `;

      await client.query(query, values);
    }

    console.log(`[DB] Upserted ${uniqueRecords.length} inspection records successfully`);
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

// ============ Sync Logging ============

export async function createSyncLog(syncType: string): Promise<number> {
  const result = await pool.query(
    `INSERT INTO sync_log (sync_type) VALUES ($1) RETURNING id`,
    [syncType]
  );
  return result.rows[0].id;
}

export async function completeSyncLog(
  id: number,
  totalRecords: number,
  changedRecords: number,
  errors: number,
  errorMessage?: string
): Promise<void> {
  await pool.query(
    `UPDATE sync_log SET
      completed_at = NOW(),
      total_records = $2,
      changed_records = $3,
      errors = $4,
      error_message = $5
     WHERE id = $1`,
    [id, totalRecords, changedRecords, errors, errorMessage]
  );
}

// ============ Match Caching ============

/**
 * Get the cached matched ticket ID for a violation.
 */
export async function getMatchedTicketId(externalId: string): Promise<number | null> {
  const result = await pool.query(
    `SELECT matched_ticket_id FROM violation_state WHERE external_id = $1`,
    [externalId]
  );
  return result.rows[0]?.matched_ticket_id ?? null;
}

/**
 * Set the matched ticket ID for a violation.
 */
export async function setMatchedTicketId(
  externalId: string,
  ticketId: number,
  matchMethod: MatchMethod,
  confidence?: MatchConfidence
): Promise<void> {
  await pool.query(
    `UPDATE violation_state SET
      matched_ticket_id = $2,
      match_method = $3,
      match_confidence = $4,
      matched_at = NOW()
     WHERE external_id = $1`,
    [externalId, ticketId, matchMethod, confidence ?? null]
  );
}

// ============ Match Logging ============

/**
 * Log a matching attempt for auditing.
 */
export async function logMatchAttempt(entry: MatchLogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO match_log
      (external_id, match_method, candidate_count, selected_ticket_id, confidence, llm_reasoning, prompt_tokens, completion_tokens, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.externalId,
      entry.matchMethod,
      entry.candidateCount,
      entry.selectedTicketId,
      entry.confidence,
      entry.llmReasoning,
      entry.promptTokens,
      entry.completionTokens,
      entry.durationMs,
    ]
  );
}
