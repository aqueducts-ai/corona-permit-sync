import { parse } from 'csv-parse/sync';
import { generatePermitExternalId, normalizePermitDate } from '../utils/external-id.js';

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

    permitRecords.push({
      permitNo,
      applied: normalizePermitDate(row['APPLIED']),
      approved: normalizePermitDate(row['APPROVED']),
      issued: normalizePermitDate(row['ISSUED']),
      finaled: normalizePermitDate(row['FINALED']),
      expired: normalizePermitDate(row['EXPIRED']),
      permitType: row['PermitType'] || '',
      permitSubType: row['PermitSubType'] || '',
      status: row['STATUS'] || '',
      siteAddress: buildAddress(row),
      siteCity: row['SITE_CITY'] || '',
      siteState: row['SITE_STATE'] || '',
      siteZip: row['SITE_ZIP'] || '',
      description: row['DESCRIPTION'] || '',
      notes: row['NOTES'] || '',
      jobValue: parseJobValue(row['JOBVALUE']),
      apn: row['APN'] || '',
      externalId: generatePermitExternalId(permitNo),
      rawData: row,
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
