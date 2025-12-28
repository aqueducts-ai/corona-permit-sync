# GIS Attributes API - Developer Guide

This guide explains how to use the Threefold GIS Attributes API to perform bulk operations on GIS entity properties.

## Overview

The GIS Attributes API allows you to:
- **Query** GIS entities by property values (e.g., find parcels by APN)
- **Upsert** attributes into entities (merge new key-value pairs)
- **Remove** specific attributes from entities
- Process **bulk operations** on thousands of entities with pagination

## Authentication

### Obtaining an MCP Token

You need an MCP token with **write** or **config** permissions. Contact your organization administrator to generate one from the Threefold admin panel.

### Required Role

Your organization role must be one of:
- **Super-Admin**
- **Owner**
- **Admin**

Members and managers do not have permission to modify GIS data.

### Using the Token

Include the token in the `Authorization` header:

```bash
curl -X POST https://app.threefold.ai/api/external/gis-attributes \
  -H "Authorization: Bearer YOUR_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

## Endpoint

```
POST /api/external/gis-attributes
```

## Request Format

```json
{
  "query": {
    "layerName": "string (required)",
    "filters": [
      {
        "key": "string",
        "operator": "string",
        "value": "string | number | string[]"
      }
    ],
    "limit": 10000,
    "offset": 0
  },
  "operation": "upsert | remove",
  "attributes": { ... } | [ ... ],
  "includeDetails": true
}
```

### Query Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `layerName` | string | Yes | Name of the GIS layer (e.g., "Parcels", "Districts") |
| `filters` | array | Yes | Array of property filters to match entities |
| `limit` | number | No | Max entities per request (default: 10,000, max: 100,000) |
| `offset` | number | No | Skip entities for pagination (default: 0) |

### Filter Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equals | `{ "key": "APN", "operator": "eq", "value": "12341" }` |
| `neq` | Not equals | `{ "key": "status", "operator": "neq", "value": "inactive" }` |
| `gt` | Greater than | `{ "key": "building_age", "operator": "gt", "value": 25 }` |
| `gte` | Greater than or equal | `{ "key": "sqft", "operator": "gte", "value": 1000 }` |
| `lt` | Less than | `{ "key": "year_built", "operator": "lt", "value": 1980 }` |
| `lte` | Less than or equal | `{ "key": "floors", "operator": "lte", "value": 3 }` |
| `like` | SQL LIKE pattern | `{ "key": "address", "operator": "like", "value": "%Main St%" }` |
| `ilike` | Case-insensitive LIKE | `{ "key": "owner", "operator": "ilike", "value": "%smith%" }` |
| `in` | Value in array | `{ "key": "zone", "operator": "in", "value": ["R1", "R2", "R3"] }` |
| `is_null` | Property is null | `{ "key": "inspector", "operator": "is_null", "value": true }` |
| `is_not_null` | Property exists | `{ "key": "last_inspection", "operator": "is_not_null", "value": true }` |

### Property Key Requirements

Property keys must:
- Start with a letter or underscore
- Contain only alphanumeric characters, underscores, and hyphens
- Match pattern: `^[a-zA-Z_][a-zA-Z0-9_-]*$`

**Valid examples:** `APN`, `building_age`, `zone-id`, `_internal_id`

**Invalid examples:** `123abc`, `my key`, `field;DROP TABLE`

### Operations

#### Upsert Operation

Merges new attributes into existing entity properties. Existing keys are overwritten, new keys are added.

```json
{
  "operation": "upsert",
  "attributes": {
    "building_age": 25,
    "occupancy": "residential",
    "last_inspection": "2024-01-15",
    "inspector_notes": "Passed all checks"
  }
}
```

#### Remove Operation

Removes specified keys from entity properties.

```json
{
  "operation": "remove",
  "attributes": ["deprecated_field", "old_data", "temp_flag"]
}
```

### Include Details Option

Set `includeDetails: false` for large batch operations to reduce response size:

```json
{
  "includeDetails": false
}
```

## Response Format

```json
{
  "success": true,
  "operation": "upsert",
  "layerName": "Parcels",
  "entitiesMatched": 150,
  "entitiesUpdated": 150,
  "entitiesFailed": 0,
  "pagination": {
    "offset": 0,
    "limit": 10000,
    "totalMatching": 150,
    "hasMore": false,
    "nextOffset": null
  },
  "results": [
    {
      "entityId": "uuid-1234",
      "entityName": "Parcel 12341",
      "success": true,
      "previousProperties": { "APN": "12341" },
      "newProperties": { "APN": "12341", "building_age": 25 }
    }
  ],
  "warnings": []
}
```

### Response Fields

| Field | Description |
|-------|-------------|
| `success` | Whether the operation completed |
| `operation` | The operation performed |
| `layerName` | The layer that was modified |
| `entitiesMatched` | Number of entities matching query in this batch |
| `entitiesUpdated` | Number successfully updated |
| `entitiesFailed` | Number that failed to update |
| `pagination.totalMatching` | Total entities matching query (all pages) |
| `pagination.hasMore` | Whether more entities exist beyond this batch |
| `pagination.nextOffset` | Offset for next request (if hasMore is true) |
| `results` | Per-entity results (omitted if includeDetails: false) |

## Examples

### Example 1: Update a Single Parcel

```bash
curl -X POST https://app.threefold.ai/api/external/gis-attributes \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "layerName": "Parcels",
      "filters": [
        { "key": "APN", "operator": "eq", "value": "12341" }
      ]
    },
    "operation": "upsert",
    "attributes": {
      "building_age": 25,
      "occupancy": "residential",
      "last_inspection": "2024-01-15"
    }
  }'
```

### Example 2: Bulk Update by Zone

```bash
curl -X POST https://app.threefold.ai/api/external/gis-attributes \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "layerName": "Parcels",
      "filters": [
        { "key": "zone", "operator": "in", "value": ["R1", "R2"] }
      ],
      "limit": 50000
    },
    "operation": "upsert",
    "attributes": {
      "zoning_update_2024": true,
      "max_height_ft": 35
    },
    "includeDetails": false
  }'
```

### Example 3: Remove Deprecated Fields

```bash
curl -X POST https://app.threefold.ai/api/external/gis-attributes \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "layerName": "Parcels",
      "filters": [
        { "key": "deprecated_field", "operator": "is_not_null", "value": true }
      ]
    },
    "operation": "remove",
    "attributes": ["deprecated_field", "old_format_data"]
  }'
```

### Example 4: Paginated Bulk Update (100,000+ entities)

```python
import requests

MCP_TOKEN = "your_token_here"
BASE_URL = "https://app.threefold.ai/api/external/gis-attributes"
HEADERS = {
    "Authorization": f"Bearer {MCP_TOKEN}",
    "Content-Type": "application/json"
}

def update_all_commercial_districts():
    offset = 0
    limit = 50000
    total_updated = 0

    while True:
        response = requests.post(BASE_URL, headers=HEADERS, json={
            "query": {
                "layerName": "Districts",
                "filters": [
                    {"key": "district_type", "operator": "eq", "value": "commercial"}
                ],
                "limit": limit,
                "offset": offset
            },
            "operation": "upsert",
            "attributes": {"category": "high_density_commercial"},
            "includeDetails": False
        })

        result = response.json()
        total_updated += result["entitiesUpdated"]

        print(f"Updated {result['entitiesUpdated']} entities "
              f"({total_updated}/{result['pagination']['totalMatching']} total)")

        if not result["pagination"]["hasMore"]:
            break

        offset = result["pagination"]["nextOffset"]

    print(f"Complete! Updated {total_updated} entities")

update_all_commercial_districts()
```

## Error Handling

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Invalid request body or validation error |
| 401 | Missing or invalid authentication token |
| 403 | Insufficient permissions (token or role) |
| 404 | Layer not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

### Error Response Format

```json
{
  "success": false,
  "message": "Invalid request body",
  "errors": ["query.layerName is required"],
  "fieldErrors": {
    "query.layerName": ["Required"]
  }
}
```

### Common Errors

**Invalid property key:**
```json
{
  "success": false,
  "message": "Failed to process GIS attributes request",
  "errors": ["Invalid property key: \"my;key\". Keys must start with a letter or underscore and contain only alphanumeric characters, underscores, and hyphens."]
}
```

**Layer not found:**
```json
{
  "success": false,
  "message": "Failed to process GIS attributes request",
  "errors": ["Layer not found: InvalidLayerName"]
}
```

**Insufficient role:**
```json
{
  "success": false,
  "message": "Insufficient organization role",
  "errors": ["Your organization role 'member' does not have permission to modify GIS data. Admin, Owner, or Super-Admin role is required."]
}
```

## Rate Limiting

- **Limit:** 1,000 requests per hour per organization + IP combination
- **Headers:** Rate limit info included in response headers:
  - `X-RateLimit-Limit`: Maximum requests per window
  - `X-RateLimit-Remaining`: Requests remaining
  - `X-RateLimit-Reset`: When the limit resets (ISO 8601)

When rate limited (429 response):
```json
{
  "success": false,
  "message": "Too many requests. Limit: 1000 requests per 60 minutes.",
  "errors": ["Rate limit exceeded"]
}
```

The `Retry-After` header indicates seconds until you can retry.

## Best Practices

1. **Use pagination** for large datasets - process in batches of 50,000
2. **Set `includeDetails: false`** for bulk operations to reduce response size
3. **Combine filters** to target specific entities precisely
4. **Handle rate limits** with exponential backoff
5. **Validate property keys** before sending - they must be alphanumeric
6. **Use numeric values** for numeric comparisons (gt, lt, etc.) to ensure proper ordering

## API Documentation Endpoint

Get full API documentation:

```bash
curl https://app.threefold.ai/api/external/gis-attributes
```

This returns the complete API specification with examples.

## Support

For questions or issues:
- Contact your organization administrator
- Email: support@threefold.ai
