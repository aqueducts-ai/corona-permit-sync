import { config } from '../config.js';
import { getCaseNoLikePattern } from '../utils/external-id.js';
import type { CandidateTicket, TicketsByLocationRequest } from '../matching/types.js';

const THREEFOLD_SOURCE = 'TrakIT';

// Rate limiting: minimum ms between API calls
const MIN_REQUEST_INTERVAL_MS = 200;
let lastRequestTime = 0;

/**
 * Ensure minimum interval between Threefold API calls.
 * Prevents overwhelming the API with rapid requests.
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

interface TicketReference {
  ticketId: number;
  externalId: string;
}

interface TicketByReferenceResponse {
  ticket_id: number;
  external_id: string;
}

interface TicketsByPatternResponse {
  tickets: TicketReference[];
}

/**
 * Find a Threefold ticket by its external ID.
 */
export async function findTicketByExternalId(externalId: string): Promise<TicketReference | null> {
  await rateLimitedRequest();

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/ticket-by-reference?` +
    new URLSearchParams({
      external_id: externalId,
      source: THREEFOLD_SOURCE,
    }),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
      },
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to find ticket: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as TicketByReferenceResponse;
  return {
    ticketId: data.ticket_id,
    externalId: data.external_id,
  };
}

/**
 * Find all Threefold tickets linked to a case number.
 * Uses LIKE pattern matching on external_id.
 */
export async function findTicketsByCaseNo(caseNo: string): Promise<TicketReference[]> {
  await rateLimitedRequest();

  const pattern = getCaseNoLikePattern(caseNo);

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/tickets-by-reference-pattern?` +
    new URLSearchParams({
      pattern,
      source: THREEFOLD_SOURCE,
    }),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
      },
    }
  );

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`Failed to find tickets by case: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as TicketsByPatternResponse;
  return data.tickets || [];
}

/**
 * Update ticket status via Threefold external API.
 */
export async function updateTicketStatus(ticketId: number, statusId: number): Promise<void> {
  await rateLimitedRequest();

  const formData = new FormData();
  formData.append('ticket_id', ticketId.toString());
  formData.append('status_id', statusId.toString());

  const response = await fetch(`${config.threefoldApiUrl}/api/change-status/external`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.threefoldApiToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update ticket status: ${response.status} ${error}`);
  }
}

/**
 * Add a comment to a Threefold ticket.
 */
export async function addTicketComment(ticketId: number, content: string): Promise<void> {
  await rateLimitedRequest();

  const formData = new FormData();
  formData.append('ticket_id', ticketId.toString());
  formData.append('content', content);

  const response = await fetch(`${config.threefoldApiUrl}/api/comments/external`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.threefoldApiToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to add comment: ${response.status} ${error}`);
  }
}

/**
 * Move a ticket to a specific workflow step.
 */
export async function moveTicketToStep(ticketId: number, stepId: number): Promise<void> {
  await rateLimitedRequest();

  const formData = new FormData();
  formData.append('ticket_id', ticketId.toString());
  formData.append('step_id', stepId.toString());

  const response = await fetch(`${config.threefoldApiUrl}/api/change-step/external`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.threefoldApiToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to move ticket to step: ${response.status} ${error}`);
  }
}

/**
 * Close a ticket by moving it to the "Close Violation" workflow step.
 */
export async function closeTicket(ticketId: number, reason: string): Promise<void> {
  await moveTicketToStep(ticketId, config.closeViolationStepId);
  await addTicketComment(ticketId, `Automatically closed: ${reason}`);
}

/**
 * Response structure from the location-based ticket search.
 */
interface TicketsByLocationResponse {
  tickets: Array<{
    ticket_id: number;
    title: string;
    description: string;
    address: string;
    lat: number;
    lng: number;
    status: string;
    created_at: string;
    ticket_type: string;
    external_id?: string;
  }>;
}

/**
 * Fetch tickets near a location using Threefold's location API.
 */
export async function fetchTicketsByLocation(
  request: TicketsByLocationRequest
): Promise<CandidateTicket[]> {
  await rateLimitedRequest();

  const body: Record<string, unknown> = {
    radius: request.radius,
    org_id: config.threefoldOrgId,
  };

  if (request.address) {
    body.address = request.address;
  }
  if (request.lat !== undefined && request.lng !== undefined) {
    body.lat = request.lat;
    body.lng = request.lng;
  }
  if (request.include_resolved !== undefined) {
    body.include_resolved = request.include_resolved;
  }
  if (request.from_date) {
    body.from_date = request.from_date;
  }
  if (request.to_date) {
    body.to_date = request.to_date;
  }
  if (request.status_types) {
    body.status_types = request.status_types;
  }
  if (request.limit) {
    body.limit = request.limit;
  }
  if (request.gis_intersections) {
    body.gis_intersections = request.gis_intersections;
  }

  const response = await fetch(
    `${config.threefoldApiUrl}/api/external/tickets/by-location`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch tickets by location: ${response.status} ${error}`);
  }

  const data = await response.json() as TicketsByLocationResponse;

  // Map snake_case API response to camelCase interface
  return (data.tickets || []).map(t => ({
    ticketId: t.ticket_id,
    title: t.title,
    description: t.description,
    address: t.address,
    lat: t.lat,
    lng: t.lng,
    status: t.status,
    createdAt: t.created_at,
    ticketType: t.ticket_type,
    externalId: t.external_id,
  }));
}

/**
 * Response from the external reference update API.
 */
interface UpdateExternalReferenceResponse {
  external_reference: {
    id: string;
    ticket_id: number;
    external_id: string;
    source: string;
  } | null;
  previous_reference: {
    id: string;
    ticket_id: number;
    external_id: string;
    source: string;
  } | null;
  action: 'created' | 'updated' | 'deleted' | 'no_change';
}

/**
 * Set or update the external ID on a Threefold ticket.
 * This "stamps" the ticket with our violation's external ID for future lookups.
 */
export async function setTicketExternalId(
  ticketId: number,
  externalId: string
): Promise<{ action: string }> {
  await rateLimitedRequest();

  const formData = new FormData();
  formData.append('ticket_id', ticketId.toString());
  formData.append('source', THREEFOLD_SOURCE);
  formData.append('external_id', externalId);
  formData.append('org_id', config.threefoldOrgId);

  const response = await fetch(
    `${config.threefoldApiUrl}/api/update-external-reference/external`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.threefoldApiToken}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to set external reference: ${response.status} ${error}`);
  }

  const data = await response.json() as UpdateExternalReferenceResponse;
  console.log(`[THREEFOLD] External ID ${data.action}: ticket #${ticketId} → ${externalId}`);

  return { action: data.action };
}
