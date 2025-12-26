import { parse } from 'csv-parse/sync';
import { generateViolationExternalId, normalizeDate } from '../utils/external-id.js';

export interface ViolationRecord {
  activityId: string;
  violationType: string;
  violationStatus: string;
  dateObserved: string;
  dateCorrected: string | null;
  siteAddress: string;
  siteCity: string;
  siteState: string;
  siteZip: string;
  caseNo: string;
  caseStarted: string;
  caseClosed: string | null;
  caseType: string;
  caseSubType: string;
  // Computed
  externalId: string;
}

/**
 * Parse violations CSV content.
 *
 * Expected columns:
 * ActivityID, Violation_Type, Violation_Status, DATE_OBSERVED, DATE_CORRECTED,
 * SITE_ADDR, SITE_CITY, SITE_STATE, SITE_ZIP, CASE_NO, STARTED, CLOSED, CaseType, CaseSubType
 */
export async function parseViolationsCsv(csvContent: string): Promise<ViolationRecord[]> {
  // Remove BOM if present
  const content = csvContent.replace(/^\uFEFF/, '');

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((row: Record<string, string>) => {
    const caseNo = row['CASE_NO'] || '';
    const violationType = row['Violation_Type'] || '';
    const dateObserved = row['DATE_OBSERVED'] || '';

    return {
      activityId: row['ActivityID'] || '',
      violationType,
      violationStatus: row['Violation_Status'] || '',
      dateObserved,
      dateCorrected: row['DATE_CORRECTED'] || null,
      siteAddress: row['SITE_ADDR'] || '',
      siteCity: row['SITE_CITY'] || '',
      siteState: row['SITE_STATE'] || '',
      siteZip: row['SITE_ZIP'] || '',
      caseNo,
      caseStarted: row['STARTED'] || '',
      caseClosed: row['CLOSED'] || null,
      caseType: row['CaseType'] || '',
      caseSubType: row['CaseSubType'] || '',
      externalId: generateViolationExternalId(caseNo, violationType, normalizeDate(dateObserved)),
    };
  });
}
