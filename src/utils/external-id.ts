/**
 * External ID generation for TrakIT records.
 *
 * Format: violation|{CASE_NO}|{Violation_Type}|{DATE_OBSERVED}
 * Example: "violation|CC24-1354|STAGNANT WATER|2024-08-27"
 *
 * This format is:
 * - Readable for debugging
 * - Queryable with LIKE for case-based lookups
 * - Deterministic (same input = same output)
 */

/**
 * Generate external ID for a violation record.
 */
export function generateViolationExternalId(
  caseNo: string,
  violationType: string,
  dateObserved: string
): string {
  return `violation|${caseNo}|${violationType}|${dateObserved}`;
}

/**
 * Extract case number from an external ID.
 * Returns null if not a violation external ID.
 */
export function extractCaseNoFromExternalId(externalId: string): string | null {
  if (!externalId.startsWith('violation|')) {
    return null;
  }
  const parts = externalId.split('|');
  return parts[1] || null;
}

/**
 * Generate LIKE pattern for finding all violations for a case.
 * Used for inspection matching.
 */
export function getCaseNoLikePattern(caseNo: string): string {
  return `violation|${caseNo}|%`;
}

/**
 * Normalize date from TrakIT format to ISO-like format.
 *
 * Input: "8/27/2024 12:00:00 AM" or "8/27/2024"
 * Output: "2024-08-27"
 */
export function normalizeDate(dateStr: string): string {
  if (!dateStr) return '';

  // Remove time portion if present
  const datePart = dateStr.split(' ')[0];
  const parts = datePart.split('/');

  if (parts.length !== 3) return dateStr;

  const [month, day, year] = parts;
  const mm = month.padStart(2, '0');
  const dd = day.padStart(2, '0');

  return `${year}-${mm}-${dd}`;
}
