import { parse } from 'csv-parse/sync';
import { generatePermitExternalId, normalizePermitDate } from '../utils/external-id.js';

/**
 * Sanitize a string by removing null characters and other problematic Unicode.
 * PostgreSQL cannot store \u0000 (null byte) in text fields.
 */
function sanitizeString(str: string | undefined | null): string {
  if (!str) return '';
  // Remove null bytes and other control characters (except newlines/tabs)
  return str.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export interface PermitRecord {
  permitNo: string;
  applied: string | null;
  approved: string | null;
  issued: string | null;
  finaled: string | null;
  expired: string | null;
  permitType: string;
  permitSubType: string;
  status: string;
  siteAddress: string;
  siteCity: string;
  siteState: string;
  siteZip: string;
  description: string;
  notes: string;
  jobValue: number | null;
  apn: string;
  // Computed
  externalId: string;
  // Raw data for storage
  rawData: Record<string, string>;
}

/**
 * Build a full address from CSV components.
 */
function buildAddress(row: Record<string, string>): string {
  const parts: string[] = [];

  // Site number + street name
  const siteNumber = row['SITE_NUMBER'] || row['SITE_ADDR']?.split(' ')[0] || '';
  const streetName = row['SITE_STREETNAME'] || '';
  const unitNo = row['SITE_UNIT_NO'] || '';

  if (siteNumber && streetName) {
    let addr = `${siteNumber} ${streetName}`;
    if (unitNo) {
      addr += ` ${unitNo}`;
    }
    parts.push(addr);
  } else if (row['SITE_ADDR']) {
    // Fall back to full SITE_ADDR
    let addr = row['SITE_ADDR'];
    if (unitNo && !addr.includes(unitNo)) {
      addr += ` ${unitNo}`;
    }
    parts.push(addr);
  }

  // City, State, Zip
  const city = row['SITE_CITY'] || '';
  const state = row['SITE_STATE'] || '';
  const zip = row['SITE_ZIP'] || '';

  if (city) {
    parts.push(city);
  }
  if (state || zip) {
    parts.push(`${state} ${zip}`.trim());
  }

  return parts.join(', ');
}

/**
 * Parse job value, handling commas and empty values.
 */
function parseJobValue(value: string): number | null {
  if (!value || value.trim() === '') {
    return null;
  }
  // Remove commas and parse
  const cleaned = value.replace(/,/g, '').trim();
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parse permits CSV content.
 *
 * Expected columns:
 * PERMIT_NO, APPLIED, APPROVED, ISSUED, FINALED, EXPIRED, PermitType, PermitSubType,
 * STATUS, SITE_ADDR, SITE_NUMBER, SITE_STREETID, SITE_STREETNAME, SITE_UNIT_NO,
 * SITE_CITY, SITE_STATE, SITE_ZIP, SITE_ST_NO, DESCRIPTION, NOTES, JOBVALUE,
 * permit_count, issued_count, applied_count, finaled_count, APN
 */
export async function parsePermitsCsv(csvContent: string): Promise<PermitRecord[]> {
  // Remove BOM if present
  const content = csvContent.replace(/^\uFEFF/, '');

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true, // Handle rows with varying column counts
  });

  const permitRecords: PermitRecord[] = [];

  for (const row of records as Record<string, string>[]) {
    const permitNo = row['PERMIT_NO'] || '';

    // Skip rows without a permit number
    if (!permitNo) {
      continue;
    }

    // Sanitize raw data to remove null bytes
    const sanitizedRow: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      sanitizedRow[key] = sanitizeString(value);
    }

    permitRecords.push({
      permitNo: sanitizeString(permitNo),
      applied: normalizePermitDate(sanitizedRow['APPLIED']),
      approved: normalizePermitDate(sanitizedRow['APPROVED']),
      issued: normalizePermitDate(sanitizedRow['ISSUED']),
      finaled: normalizePermitDate(sanitizedRow['FINALED']),
      expired: normalizePermitDate(sanitizedRow['EXPIRED']),
      permitType: sanitizedRow['PermitType'] || '',
      permitSubType: sanitizedRow['PermitSubType'] || '',
      status: sanitizedRow['STATUS'] || '',
      siteAddress: sanitizeString(buildAddress(sanitizedRow)),
      siteCity: sanitizedRow['SITE_CITY'] || '',
      siteState: sanitizedRow['SITE_STATE'] || '',
      siteZip: sanitizedRow['SITE_ZIP'] || '',
      description: sanitizedRow['DESCRIPTION'] || '',
      notes: sanitizedRow['NOTES'] || '',
      jobValue: parseJobValue(sanitizedRow['JOBVALUE']),
      apn: sanitizedRow['APN'] || '',
      externalId: generatePermitExternalId(sanitizeString(permitNo)),
      // Don't store full row to save memory - all needed fields are extracted above
      rawData: {},
    });
  }

  return permitRecords;
}

/**
 * Generate a hash of permit fields for change detection.
 * Returns a string that can be compared to detect any field changes.
 */
export function generatePermitHash(record: PermitRecord): string {
  const fields = [
    record.status,
    record.applied,
    record.approved,
    record.issued,
    record.finaled,
    record.expired,
    record.permitType,
    record.permitSubType,
    record.siteAddress,
    record.description,
    record.notes,
    record.jobValue?.toString() ?? '',
    record.apn,
  ];
  return fields.join('|');
}
