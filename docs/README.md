# Threefold External API Documentation

## Overview

This directory contains comprehensive API documentation for the Threefold platform's external APIs. The documentation is designed for developers, API consumers, and system integrators who need to integrate with Threefold services.

## Available APIs

### 🏗️ Permits API

Manage building permits, inspections, and permit workflows.

| Document | Description |
|----------|-------------|
| [permits-openapi.yaml](./permits-openapi.yaml) | OpenAPI 3.0 specification |
| [permits-integration-guide.md](./permits-integration-guide.md) | Integration guide with code examples |

**Quick Links:**
- Create/update permits individually or in bulk
- Query permits with filtering and pagination
- Rate limits: 1000 reads/min, 100 writes/min, 10 bulk ops/min

### 🔍 Duplicate Detection API

Detect and manage duplicate tickets using semantic, geographic, and temporal analysis.

| Document | Description |
|----------|-------------|
| [duplicate-detection-api.md](./duplicate-detection-api.md) | Primary API reference |
| [duplicate-detection-openapi.yaml](./duplicate-detection-openapi.yaml) | OpenAPI 3.0 specification |
| [duplicate-detection-integration-guide.md](./duplicate-detection-integration-guide.md) | Integration guide |
| [duplicate-detection-postman-collection.json](./duplicate-detection-postman-collection.json) | Postman collection |

### 📍 Location APIs

| Document | Description |
|----------|-------------|
| [address-lookup.md](./address-lookup.md) | Address geocoding and lookup |
| [proximity-search-api.md](./proximity-search-api.md) | Find nearby tickets/permits |
| [tickets-by-location.md](./tickets-by-location.md) | Location-based ticket queries |

### ⚙️ Other APIs

| Document | Description |
|----------|-------------|
| [user-preferences.md](./user-preferences.md) | User preference management |
| [step-agent-duplicate-detection.md](./step-agent-duplicate-detection.md) | AI agent configuration |

---

## Authentication

All external API endpoints require authentication via Bearer token:

```bash
curl -X GET "https://app.threefold.ai/api/external/permits" \
  -H "Authorization: Bearer ext_your_token_here" \
  -H "Content-Type: application/json"
```

### Token Types

| Type | Format | Use Case |
|------|--------|----------|
| External API Token | `ext_...` | Third-party integrations, scripts |
| MCP Token | Signed JWT | AI agent integrations |
| Clerk JWT | `eyJ...` | Web application (internal) |

### Obtaining Tokens

1. **External API Token**: Request from your organization administrator in Threefold Settings → API Keys
2. **MCP Token**: Generated automatically for AI agent integrations

---

## Rate Limiting

All endpoints enforce rate limits with the following headers:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed |
| `X-RateLimit-Remaining` | Requests remaining in window |
| `X-RateLimit-Reset` | Window reset timestamp |

### Default Limits by API

| API | Read | Write | Bulk |
|-----|------|-------|------|
| Permits | 1000/min | 100/min | 10/min |
| Tickets | 1000/min | 100/min | 10/min |
| Duplicate Detection | 100/min | 10/min | 5/min |

---

## Error Handling

### Standard Error Response

```json
{
  "success": false,
  "message": "Human-readable error description",
  "errors": [
    {
      "path": "field_name",
      "message": "Specific validation error"
    }
  ]
}
```

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Validation error |
| 401 | Invalid/missing authentication |
| 403 | Insufficient permissions |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Server error |

---

## Environments

| Environment | Base URL |
|-------------|----------|
| Production | `https://app.threefold.ai/api/external` |
| Staging | `https://staging.threefold.ai/api/external` |
| Local | `http://localhost:3000/api/external` |

---

## Support

- **Bug Reports**: Use Linear issue tracking
- **Feature Requests**: Submit via product management channels
- **Integration Support**: Consult the relevant integration guide
