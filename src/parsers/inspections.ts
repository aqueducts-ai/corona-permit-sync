import { parse } from 'csv-parse/sync';

export interface InspectionRecord {
  caseNo: string;
  completedDate: string | null;
  createdBy: string;
  createdDate: string;
  inspectionType: string;
  inspector: string;
  notes: string | null;
  remarks: string | null;
  result: string;
  scheduledDate: string;
  uniqueKey: string;
}

/**
 * Parse inspections CSV content.
 *
 * Expected columns:
 * CASE_NO, CAPOVERRIDE, COMPLETED_DATE, COMPLETED_TIME, CREATED_BY, CREATED_DATE,
 * CREATED_TIME, DURATION, DURATION_EST, exID, InspectionType, INSPECTOR, LOCKID,
 * NOTES, PathURL, PathURLDateAdded, RECORDID, REMARKS, RESULT, SCHEDULED_DATE,
 * SCHEDULED_TIME, SEQID, Unique_Key
 */
export async function parseInspectionsCsv(csvContent: string): Promise<InspectionRecord[]> {
  // Remove BOM if present
  const content = csvContent.replace(/^\uFEFF/, '');

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((row: Record<string, string>) => ({
    caseNo: row['CASE_NO'] || '',
    completedDate: row['COMPLETED_DATE'] || null,
    createdBy: row['CREATED_BY'] || '',
    createdDate: row['CREATED_DATE'] || '',
    inspectionType: row['InspectionType'] || '',
    inspector: row['INSPECTOR'] || '',
    notes: row['NOTES'] || null,
    remarks: row['REMARKS'] || null,
    result: row['RESULT'] || '',
    scheduledDate: row['SCHEDULED_DATE'] || '',
    uniqueKey: row['Unique_Key'] || '',
  }));
}
