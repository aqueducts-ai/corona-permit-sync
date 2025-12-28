# Permits API Integration Guide

<sub>Last updated: 2025-12-27</sub>

This guide provides practical examples and best practices for integrating with the Threefold Permits API.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Authentication](#authentication)
3. [Basic Operations](#basic-operations)
4. [Bulk Import](#bulk-import)
5. [Error Handling](#error-handling)
6. [Rate Limiting](#rate-limiting)
7. [Best Practices](#best-practices)
8. [Code Examples](#code-examples)

## Getting Started

### Base URL

| Environment | URL |
|-------------|-----|
| Production | `https://app.threefold.ai/api/external` |
| Staging | `https://staging.threefold.ai/api/external` |
| Local | `http://localhost:3000/api/external` |

### Prerequisites

1. **API Token**: Obtain an external API token from your organization administrator
2. **Organization ID**: Your token is scoped to a specific organization
3. **Permit Types**: Query available types before creating permits

## Authentication

All API requests require a Bearer token in the Authorization header:

```http
Authorization: Bearer ext_your_token_here
```

### Token Types

| Type | Format | Use Case |
|------|--------|----------|
| External API Token | `ext_...` | Third-party integrations, scripts |
| MCP Token | Signed JWT | AI agent integrations |

### Example Request

```bash
curl -X GET "https://app.threefold.ai/api/external/permits" \
  -H "Authorization: Bearer ext_abc123..." \
  -H "Content-Type: application/json"
```

## Basic Operations

### List Permits

```javascript
const response = await fetch('/api/external/permits?limit=20&status_id=1', {
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

const { success, data, meta } = await response.json();
console.log(`Found ${meta.count} permits`);
```

### Get Permit by ID or Number

Both formats work interchangeably:

```javascript
// By numeric ID
const permit1 = await getPermit('123');

// By permit number
const permit2 = await getPermit('PERMIT-2025-0001');

async function getPermit(id) {
  const response = await fetch(`/api/external/permits/${id}`, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` }
  });
  return response.json();
}
```

### Create a Permit

```javascript
const response = await fetch('/api/external/permits', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    permit_type_id: 1,
    permit_subtype_id: 5,
    status_id: 1,
    address: '123 Main St',
    description: 'New residential construction',
    job_value: 250000,
    applied_at: new Date().toISOString()
  })
});

const { success, data } = await response.json();
console.log(`Created permit: ${data.permit_no}`);
```

### Update a Permit

```javascript
const response = await fetch('/api/external/permits/PERMIT-2025-0001', {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    status_id: 2,
    approved_at: new Date().toISOString(),
    notes: 'Approved by building official'
  })
});
```

### Archive a Permit

```javascript
const response = await fetch('/api/external/permits/PERMIT-2025-0001', {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${API_TOKEN}` }
});
```

## Bulk Import

For importing large datasets, use bulk mode (up to 1000 permits per request).

### Basic Bulk Import

```javascript
const response = await fetch('/api/external/permits', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    mode: 'bulk',
    batch_id: crypto.randomUUID(), // Optional tracking ID
    permits: [
      {
        permit_type_id: 1,
        address: '123 Main St',
        description: 'New construction'
      },
      {
        permit_type_id: 1,
        address: '456 Oak Ave',
        description: 'Renovation'
      }
    ]
  })
});

const { success, data } = await response.json();
console.log(`Created: ${data.created}, Failed: ${data.failed}`);

// Handle partial failures
if (data.errors.length > 0) {
  for (const error of data.errors) {
    console.error(`Row ${error.index}: ${error.error}`);
    console.error(`  Address: ${error.address}`);
  }
}
```

### Paginated Bulk Import

For datasets larger than 1000 records:

```javascript
async function importPermits(permits, batchSize = 500) {
  const results = {
    created: 0,
    failed: 0,
    errors: []
  };

  for (let i = 0; i < permits.length; i += batchSize) {
    const batch = permits.slice(i, i + batchSize);
    const batchId = crypto.randomUUID();
    
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}...`);
    
    const response = await fetch('/api/external/permits', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mode: 'bulk',
        batch_id: batchId,
        permits: batch
      })
    });

    const { data } = await response.json();
    results.created += data.created;
    results.failed += data.failed;
    
    // Adjust error indices to reflect original position
    for (const error of data.errors) {
      results.errors.push({
        ...error,
        index: i + error.index
      });
    }

    // Respect rate limits
    await delay(1000);
  }

  return results;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

## Error Handling

### Error Response Format

All errors follow a consistent format:

```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "path": "permit_type_id",
      "message": "ID 999 is a subtype, not a parent type. Use permit_subtype_id instead."
    }
  ]
}
```

### Common Error Codes

| Status | Meaning | Action |
|--------|---------|--------|
| 400 | Validation failed | Check `errors` array for details |
| 401 | Authentication failed | Verify token is valid |
| 404 | Not found | Check permit ID/number |
| 429 | Rate limit exceeded | Wait and retry with backoff |
| 500 | Server error | Retry with exponential backoff |

### Retry Logic

```javascript
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || '60';
        console.log(`Rate limited. Retrying in ${retryAfter}s...`);
        await delay(parseInt(retryAfter) * 1000);
        continue;
      }
      
      if (response.status >= 500) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.log(`Server error. Retrying in ${backoff}ms...`);
        await delay(backoff);
        continue;
      }
      
      return response;
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      await delay(Math.pow(2, attempt) * 1000);
    }
  }
}
```

## Rate Limiting

### Limits by Operation Type

| Operation | Limit | Window | Key |
|-----------|-------|--------|-----|
| Read (GET) | 1000 | 1 minute | `permits:read` |
| Write (POST single, PATCH, DELETE) | 100 | 1 minute | `permits:write` |
| Bulk (POST bulk) | 10 | 1 minute | `permits:bulk-write` |

### Rate Limit Headers

Every response includes rate limit information:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 2025-01-15T12:00:00.000Z
```

### Handling Rate Limits

```javascript
async function makeRequest(url, options) {
  const response = await fetch(url, options);
  
  // Log remaining quota
  const remaining = response.headers.get('X-RateLimit-Remaining');
  console.log(`Rate limit remaining: ${remaining}`);
  
  if (response.status === 429) {
    const reset = response.headers.get('X-RateLimit-Reset');
    const waitMs = new Date(reset) - new Date();
    throw new RateLimitError(`Rate limited. Reset at ${reset}`, waitMs);
  }
  
  return response;
}
```

## Best Practices

### 1. Validate Types Before Creating

Always fetch and cache permit types to validate before creation:

```javascript
let permitTypesCache = null;

async function getPermitTypes() {
  if (!permitTypesCache) {
    const response = await fetch('/api/external/permits/types', {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    });
    const { data } = await response.json();
    permitTypesCache = data;
  }
  return permitTypesCache;
}

function validatePermitType(typeId, subtypeId) {
  const types = permitTypesCache;
  const parentType = types.find(t => t.id === typeId);
  
  if (!parentType) {
    throw new Error(`Invalid permit_type_id: ${typeId}`);
  }
  
  if (subtypeId) {
    const subtype = parentType.children?.find(s => s.id === subtypeId);
    if (!subtype) {
      throw new Error(`Subtype ${subtypeId} does not belong to type ${typeId}`);
    }
  }
}
```

### 2. Use Idempotency Keys

For bulk imports, use `batch_id` to track operations:

```javascript
const batchId = crypto.randomUUID();
console.log(`Starting import batch: ${batchId}`);

// Store batch_id for troubleshooting
await logBatch(batchId, permits.length);

const response = await fetch('/api/external/permits', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    mode: 'bulk',
    batch_id: batchId,
    permits
  })
});
```

### 3. Handle Partial Failures

Bulk operations may partially succeed. Always check errors:

```javascript
const { data } = await response.json();

if (data.failed > 0) {
  console.warn(`${data.failed} permits failed to import`);
  
  // Log failures for review
  for (const error of data.errors) {
    await logFailure({
      index: error.index,
      error: error.error,
      permit_no: error.permit_no,
      address: error.address
    });
  }
}

// Continue processing with successful permits
const createdIds = data.created_ids;
```

### 4. Use Appropriate Field Types

```javascript
// Correct: Use numbers for IDs
const permit = {
  permit_type_id: 1,      // number
  status_id: 2,           // number
  job_value: 250000.50,   // number
  parsed_lat: 37.7749,    // number
  parsed_lng: -122.4194   // number
};

// Correct: Use ISO 8601 for dates
const dates = {
  applied_at: '2025-01-15T09:30:00.000Z',
  approved_at: new Date().toISOString()
};

// Correct: Use null to clear optional fields
const update = {
  permit_subtype_id: null,  // Clears the subtype
  notes: null               // Clears notes
};
```

## Code Examples

### TypeScript Client

```typescript
interface Permit {
  id: number;
  permit_no: string;
  permit_type_id: number;
  permit_subtype_id?: number | null;
  status_id?: number | null;
  address?: string | null;
  description?: string | null;
  // ... other fields
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    count?: number;
    processing_time_ms: number;
  };
}

class PermitsClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new ApiError(error.message, error.errors, response.status);
    }

    return response.json();
  }

  async listPermits(params?: {
    status_id?: number;
    permit_type_id?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApiResponse<Permit[]>> {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
      });
    }
    return this.request(`/permits?${query}`);
  }

  async getPermit(id: string | number): Promise<ApiResponse<Permit>> {
    return this.request(`/permits/${id}`);
  }

  async createPermit(permit: Partial<Permit>): Promise<ApiResponse<Permit>> {
    return this.request('/permits', {
      method: 'POST',
      body: JSON.stringify(permit)
    });
  }

  async updatePermit(
    id: string | number,
    updates: Partial<Permit>
  ): Promise<ApiResponse<Permit>> {
    return this.request(`/permits/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
  }

  async archivePermit(id: string | number): Promise<ApiResponse<void>> {
    return this.request(`/permits/${id}`, { method: 'DELETE' });
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    public errors: Array<{ path: string; message: string }>,
    public status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Usage
const client = new PermitsClient(
  'https://app.threefold.ai/api/external',
  'ext_your_token'
);

const { data: permits } = await client.listPermits({
  status_id: 1,
  limit: 50
});
```

### Python Client

```python
import requests
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from datetime import datetime

@dataclass
class ApiError(Exception):
    message: str
    errors: List[Dict[str, str]]
    status_code: int

class PermitsClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url
        self.headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }
    
    def _request(self, method: str, path: str, **kwargs) -> Dict[str, Any]:
        response = requests.request(
            method,
            f'{self.base_url}{path}',
            headers=self.headers,
            **kwargs
        )
        
        data = response.json()
        
        if not response.ok:
            raise ApiError(
                data.get('message', 'Unknown error'),
                data.get('errors', []),
                response.status_code
            )
        
        return data
    
    def list_permits(
        self,
        status_id: Optional[int] = None,
        permit_type_id: Optional[int] = None,
        search: Optional[str] = None,
        limit: int = 20,
        offset: int = 0
    ) -> Dict[str, Any]:
        params = {'limit': limit, 'offset': offset}
        if status_id: params['status_id'] = status_id
        if permit_type_id: params['permit_type_id'] = permit_type_id
        if search: params['search'] = search
        
        return self._request('GET', '/permits', params=params)
    
    def get_permit(self, permit_id: str) -> Dict[str, Any]:
        return self._request('GET', f'/permits/{permit_id}')
    
    def create_permit(self, permit: Dict[str, Any]) -> Dict[str, Any]:
        return self._request('POST', '/permits', json=permit)
    
    def bulk_create(
        self,
        permits: List[Dict[str, Any]],
        batch_id: Optional[str] = None
    ) -> Dict[str, Any]:
        payload = {
            'mode': 'bulk',
            'permits': permits
        }
        if batch_id:
            payload['batch_id'] = batch_id
        
        return self._request('POST', '/permits', json=payload)
    
    def update_permit(
        self,
        permit_id: str,
        updates: Dict[str, Any]
    ) -> Dict[str, Any]:
        return self._request('PATCH', f'/permits/{permit_id}', json=updates)
    
    def archive_permit(self, permit_id: str) -> Dict[str, Any]:
        return self._request('DELETE', f'/permits/{permit_id}')

# Usage
client = PermitsClient(
    'https://app.threefold.ai/api/external',
    'ext_your_token'
)

# List permits
result = client.list_permits(status_id=1, limit=50)
for permit in result['data']:
    print(f"{permit['permit_no']}: {permit['address']}")

# Create permit
new_permit = client.create_permit({
    'permit_type_id': 1,
    'address': '123 Main St',
    'description': 'New construction'
})
print(f"Created: {new_permit['data']['permit_no']}")

# Bulk import
import uuid
result = client.bulk_create(
    permits=[
        {'permit_type_id': 1, 'address': '100 First St'},
        {'permit_type_id': 1, 'address': '200 Second St'},
    ],
    batch_id=str(uuid.uuid4())
)
print(f"Created: {result['data']['created']}, Failed: {result['data']['failed']}")
```

## Related Documentation

- [Permits OpenAPI Specification](./permits-openapi.yaml)
- [Authentication Guide](./authentication.md)
- [Permits Feature Overview](../features/permits.md)
