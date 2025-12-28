import { config } from '../config.js';
import { PermitRecord } from '../parsers/permits.js';

// Rate limiting: minimum ms between API calls
const MIN_REQUEST_INTERVAL_MS = 200;
let lastRequestTime = 0;

/**
 * Ensure minimum interval between Threefold API calls.
 */
async function rateLimitedRequest(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;

  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    const waitTime = MIN_REQUEST_INTERVAL_MS - elapsed;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

// ============ Type Definitions ============

export interface ThreefoldPermitType {
  id: number;
  name: string;
  description: string | null;
  parent_id: number | null;
  icon: string | null;
  color: string | null;
  is_default: boolean;
  enabled: boolean;
  sort_order: number;
  children?: ThreefoldPermitType[];
}

export interface ThreefoldPermitStatus {
  id: number;
  status_name: string;
  status_icon: string | null;
  status_color: string | null;
  status_type: 'applied' | 'approved' | 'issued' | 'finaled' | 'expired';
  sort_order: number;
}

export interface ThreefoldPermit {
  id: number;
  permit_no: string;
  permit_type_id: number;
  permit_subtype_id: number | null;
  status_id: number | null;
  description: string | null;
  notes: string | null;
  job_value: number | null;
  address: string | null;
  parsed_lat: number | null;
  parsed_lng: number | null;
  apn: string | null;
  applied_at: string | null;
  approved_at: string | null;
  issued_at: string | null;
  finaled_at: string | null;
  expired_at: string | null;
}

interface CreatePermitRequest {
  permit_no?: string;
  permit_type_id: number;
  permit_subtype_id?: number | null;
  status_id?: number | null;
  description?: string | null;
  notes?: string | null;
  job_value?: number | null;
  address?: string | null;
  apn?: string | null;
  applied_at?: string | null;
  approved_at?: string | null;
  issued_at?: string | null;
  finaled_at?: string | null;
  expired_at?: string | null;
}

interface BulkCreateResponse {
  created: number;
  failed: number;
  created_ids: number[];
  errors: Array<{
    index: number;
    error: string;
    permit_no?: string;
    address?: string;
  }>;
}

// ============ In-Memory Caches ============

// Permit types cache: Map<name, { id, parentId }>
let permitTypesCache: Map<string, { id: number; parentId: number | null }> | null = null;
// Subtypes cache: Map<parentName, Map<subtypeName, id>>
let permitSubtypesCache: Map<string, Map<string, number>> | null = null;
// Statuses cache: Map<name, id>
let permitStatusesCache: Map<string, number> | null = null;

/**
 * Clear all caches (useful for testing or refresh).
 */
export function clearPermitCaches(): void {
  permitTypesCache = null;
  permitSubtypesCache = null;
  permitStatusesCache = null;
}

// ============ Permit Types API ============

/**
 * Fetch all permit types from Threefold and populate caches.
 */
export async function fetchPermitTypes(): Promise<ThreefoldPermitType[]> {
  await rateLimitedRequest();

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits/types?include_subtypes=true`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch permit types: ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: ThreefoldPermitType[] };

  // Populate caches
  permitTypesCache = new Map();
  permitSubtypesCache = new Map();

  for (const type of data) {
    permitTypesCache.set(type.name.toUpperCase(), { id: type.id, parentId: null });

    if (type.children && type.children.length > 0) {
      const subtypeMap = new Map<string, number>();
      for (const subtype of type.children) {
        subtypeMap.set(subtype.name.toUpperCase(), subtype.id);
      }
      permitSubtypesCache.set(type.name.toUpperCase(), subtypeMap);
    }
  }

  console.log(`[THREEFOLD] Cached ${permitTypesCache.size} permit types`);

  return data;
}

/**
 * Create a new permit type in Threefold.
 */
export async function createPermitType(
  name: string,
  parentId?: number
): Promise<ThreefoldPermitType> {
  await rateLimitedRequest();

  const body: Record<string, unknown> = {
    name,
    enabled: true,
  };

  if (parentId) {
    body.parent_id = parentId;
  }

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits/types`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create permit type '${name}': ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: ThreefoldPermitType };
  console.log(`[THREEFOLD] Created permit type: ${name} (ID: ${data.id}${parentId ? `, parent: ${parentId}` : ''})`);

  return data;
}

/**
 * Get or create a permit type by name.
 * Returns the type ID.
 */
export async function getOrCreatePermitType(typeName: string): Promise<number> {
  // Ensure cache is populated
  if (!permitTypesCache) {
    await fetchPermitTypes();
  }

  const normalizedName = typeName.toUpperCase().trim();

  // Check cache
  const cached = permitTypesCache!.get(normalizedName);
  if (cached) {
    return cached.id;
  }

  // Create new type
  const newType = await createPermitType(typeName);

  // Update cache
  permitTypesCache!.set(normalizedName, { id: newType.id, parentId: null });

  return newType.id;
}

/**
 * Get or create a permit subtype by name under a parent type.
 * Returns the subtype ID.
 */
export async function getOrCreatePermitSubtype(
  parentTypeName: string,
  subtypeName: string
): Promise<number> {
  // Ensure cache is populated
  if (!permitTypesCache || !permitSubtypesCache) {
    await fetchPermitTypes();
  }

  const normalizedParent = parentTypeName.toUpperCase().trim();
  const normalizedSubtype = subtypeName.toUpperCase().trim();

  // Get parent type ID (create if needed)
  const parentTypeId = await getOrCreatePermitType(parentTypeName);

  // Check subtype cache
  let subtypeMap = permitSubtypesCache!.get(normalizedParent);
  if (subtypeMap) {
    const cachedId = subtypeMap.get(normalizedSubtype);
    if (cachedId) {
      return cachedId;
    }
  }

  // Create new subtype
  const newSubtype = await createPermitType(subtypeName, parentTypeId);

  // Update cache
  if (!subtypeMap) {
    subtypeMap = new Map();
    permitSubtypesCache!.set(normalizedParent, subtypeMap);
  }
  subtypeMap.set(normalizedSubtype, newSubtype.id);

  return newSubtype.id;
}

// ============ Permit Statuses API ============

/**
 * Fetch all permit statuses from Threefold.
 */
export async function fetchPermitStatuses(): Promise<ThreefoldPermitStatus[]> {
  await rateLimitedRequest();

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits/statuses`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch permit statuses: ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: ThreefoldPermitStatus[] };

  // Populate cache
  permitStatusesCache = new Map();
  for (const status of data) {
    permitStatusesCache.set(status.status_name.toUpperCase(), status.id);
  }

  console.log(`[THREEFOLD] Cached ${permitStatusesCache.size} permit statuses`);

  return data;
}

/**
 * Create a new permit status in Threefold.
 */
export async function createPermitStatus(
  statusName: string,
  statusType: 'applied' | 'approved' | 'issued' | 'finaled' | 'expired' = 'applied'
): Promise<ThreefoldPermitStatus> {
  await rateLimitedRequest();

  const body = {
    status_name: statusName,
    status_type: statusType,
  };

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits/statuses`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create permit status '${statusName}': ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: ThreefoldPermitStatus };
  console.log(`[THREEFOLD] Created permit status: ${statusName} (ID: ${data.id})`);

  return data;
}

/**
 * Map CSV status to Threefold status_type.
 * This determines the lifecycle stage for auto-created statuses.
 */
function inferStatusType(statusName: string): 'applied' | 'approved' | 'issued' | 'finaled' | 'expired' {
  const upper = statusName.toUpperCase();

  if (upper.includes('FINAL') || upper === 'C OF O' || upper === 'COMPLETE') {
    return 'finaled';
  }
  if (upper.includes('ISSUED') || upper === 'CORRECTIONS READY') {
    return 'issued';
  }
  if (upper.includes('APPROVED')) {
    return 'approved';
  }
  if (upper.includes('EXPIRED') || upper.includes('CANCEL') || upper.includes('VOID')) {
    return 'expired';
  }
  // Default to 'applied' for APPLIED, PLAN CHECK, etc.
  return 'applied';
}

/**
 * Get or create a permit status by name.
 * Returns the status ID.
 */
export async function getOrCreatePermitStatus(statusName: string): Promise<number> {
  if (!statusName || statusName.trim() === '') {
    // Return null for empty status - will be handled by caller
    return 0;
  }

  // Ensure cache is populated
  if (!permitStatusesCache) {
    await fetchPermitStatuses();
  }

  const normalizedName = statusName.toUpperCase().trim();

  // Check cache
  const cachedId = permitStatusesCache!.get(normalizedName);
  if (cachedId) {
    return cachedId;
  }

  // Create new status with inferred type
  const statusType = inferStatusType(statusName);
  const newStatus = await createPermitStatus(statusName, statusType);

  // Update cache
  permitStatusesCache!.set(normalizedName, newStatus.id);

  return newStatus.id;
}

// ============ Permits CRUD API ============

/**
 * Get a permit by permit number.
 */
export async function getPermitByNumber(permitNo: string): Promise<ThreefoldPermit | null> {
  await rateLimitedRequest();

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits/${encodeURIComponent(permitNo)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get permit ${permitNo}: ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: ThreefoldPermit };
  return data;
}

/**
 * Create a single permit in Threefold.
 */
export async function createPermit(permit: CreatePermitRequest): Promise<ThreefoldPermit> {
  await rateLimitedRequest();

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(permit),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create permit: ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: ThreefoldPermit };
  return data;
}

/**
 * Update a permit in Threefold.
 */
export async function updatePermit(
  permitIdOrNo: string | number,
  updates: Partial<CreatePermitRequest>
): Promise<ThreefoldPermit> {
  await rateLimitedRequest();

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits/${encodeURIComponent(String(permitIdOrNo))}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update permit ${permitIdOrNo}: ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: ThreefoldPermit };
  return data;
}

/**
 * Bulk create permits in Threefold.
 * Maximum 1000 permits per request.
 */
export async function bulkCreatePermits(
  permits: CreatePermitRequest[],
  batchId?: string
): Promise<BulkCreateResponse> {
  await rateLimitedRequest();

  const body: Record<string, unknown> = {
    mode: 'bulk',
    permits,
  };

  if (batchId) {
    body.batch_id = batchId;
  }

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/permits`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to bulk create permits: ${response.status} ${error}`);
  }

  const { data } = await response.json() as { data: BulkCreateResponse };
  return data;
}

// ============ Helper Functions ============

/**
 * Convert a PermitRecord to a Threefold API request.
 * Resolves type/subtype/status IDs using caches.
 * Only includes fields that have values (API rejects null for optional string fields).
 */
export async function convertPermitRecordToApiRequest(
  record: PermitRecord
): Promise<{
  request: CreatePermitRequest;
  typeId: number;
  subtypeId: number | null;
  statusId: number | null;
}> {
  // Resolve permit type
  const typeId = await getOrCreatePermitType(record.permitType);

  // Resolve subtype (if exists)
  let subtypeId: number | null = null;
  if (record.permitSubType && record.permitSubType.trim() !== '') {
    subtypeId = await getOrCreatePermitSubtype(record.permitType, record.permitSubType);
  }

  // Resolve status
  let statusId: number | null = null;
  if (record.status && record.status.trim() !== '') {
    const resolvedStatusId = await getOrCreatePermitStatus(record.status);
    statusId = resolvedStatusId === 0 ? null : resolvedStatusId;
  }

  // Build request with only non-null values (API rejects null for optional string fields)
  const request: CreatePermitRequest = {
    permit_no: record.permitNo,
    permit_type_id: typeId,
  };

  // Only add optional fields if they have values
  if (subtypeId !== null) request.permit_subtype_id = subtypeId;
  if (statusId !== null) request.status_id = statusId;
  if (record.description) request.description = record.description;
  if (record.notes) request.notes = record.notes;
  if (record.jobValue !== null) request.job_value = record.jobValue;
  if (record.siteAddress) request.address = record.siteAddress;
  if (record.apn) request.apn = record.apn;
  if (record.applied) request.applied_at = record.applied;
  if (record.approved) request.approved_at = record.approved;
  if (record.issued) request.issued_at = record.issued;
  if (record.finaled) request.finaled_at = record.finaled;
  if (record.expired) request.expired_at = record.expired;

  return { request, typeId, subtypeId, statusId };
}

/**
 * Initialize permit caches by fetching types and statuses.
 */
export async function initializePermitCaches(): Promise<void> {
  console.log('[THREEFOLD] Initializing permit caches...');
  await fetchPermitTypes();
  await fetchPermitStatuses();
  console.log('[THREEFOLD] Permit caches initialized');
}
