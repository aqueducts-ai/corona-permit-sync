export enum ReportType {
  VIOLATIONS = 'violations',
  INSPECTIONS = 'inspections',
  PERMITS = 'permits',
  UNKNOWN = 'unknown',
}

/**
 * Detect the report type from the filename.
 *
 * Expected filenames:
 * - V_Threefold_Violations_and_Cases.csv
 * - V_Threefold_CASE_INSPECTIONS.csv
 * - V_Threefold_Permits.csv
 * - V_Threefold_Code_Enforcement_Cases.csv (ignored for now)
 */
export function detectReportType(filename: string): ReportType {
  const lower = filename.toLowerCase();

  if (lower.includes('violations')) {
    return ReportType.VIOLATIONS;
  }

  if (lower.includes('inspection')) {
    return ReportType.INSPECTIONS;
  }

  if (lower.includes('permit')) {
    return ReportType.PERMITS;
  }

  // Code enforcement cases are not processed yet
  return ReportType.UNKNOWN;
}
