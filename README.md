# corona-permit-sync

Corona Permit integration service - syncs permits from external systems to Threefold.

## Architecture Overview

### High-Level System Architecture

```mermaid
flowchart TB
    subgraph External["External Systems"]
        TrakIT["TrakIT System"]
        Email["Hourly Email Reports"]
    end

    subgraph Ingestion["Data Ingestion"]
        SendGrid["SendGrid\nInbound Parse"]
        Webhook["POST /webhook/sendgrid"]
    end

    subgraph Processing["Processing Layer"]
        Parser["CSV Parsers"]
        Detector["Report Type\nDetector"]
        Tracker["State Tracker"]
    end

    subgraph Matching["Ticket Matching"]
        Cache["Match Cache"]
        ExtID["External ID\nLookup"]
        LLM["LLM Matcher\n(OpenAI)"]
        Review["Review Queue"]
    end

    subgraph Storage["Data Storage"]
        DB[(PostgreSQL)]
    end

    subgraph Threefold["Threefold API"]
        TicketAPI["Ticket API"]
        LocationAPI["Location API"]
        CommentAPI["Comments API"]
    end

    TrakIT --> Email
    Email --> SendGrid
    SendGrid --> Webhook
    Webhook --> Detector
    Detector --> Parser
    Parser --> Tracker
    Tracker <--> DB
    Tracker --> Cache
    Cache --> ExtID
    ExtID --> LLM
    LLM <--> LocationAPI
    LLM --> Review
    Review --> DB
    Tracker --> TicketAPI
    Tracker --> CommentAPI
```

### Data Flow: Email to Ticket Update

```mermaid
sequenceDiagram
    participant TrakIT as TrakIT System
    participant SG as SendGrid
    participant App as Sync Service
    participant DB as PostgreSQL
    participant TF as Threefold API
    participant AI as OpenAI

    TrakIT->>SG: Hourly CSV export email
    SG->>App: POST /webhook/sendgrid

    App->>App: Parse multipart form (busboy)
    App->>App: Detect report type from filename
    App->>App: Parse CSV records

    App->>DB: Fetch current state
    App->>App: Diff: find new/changed records

    alt Has Changes
        loop Each Changed Record
            App->>DB: Check cached match
            alt Cache Hit
                App->>TF: Update ticket
            else Cache Miss
                App->>TF: Try external ID lookup
                alt Found
                    App->>TF: Update ticket
                else Not Found
                    App->>TF: Fetch nearby tickets
                    App->>AI: LLM match request
                    AI-->>App: Match decision
                    alt High Confidence
                        App->>TF: Update ticket
                        App->>DB: Cache match
                    else Low Confidence
                        App->>DB: Queue for review
                    end
                end
            end
        end
    end

    App->>DB: Update state table
    App->>DB: Log sync run
    App-->>SG: 200 OK
```

### Violations Sync Flow

```mermaid
flowchart TD
    Start([CSV Received]) --> Parse[Parse CSV Records]
    Parse --> Initial{First Sync?}

    Initial -->|Yes| Populate[Populate State Table]
    Populate --> Done([Complete])

    Initial -->|No| Diff[Diff Against Stored State]
    Diff --> Changes{Any Changes?}

    Changes -->|No| Skip[Skip Processing]
    Skip --> Done

    Changes -->|Yes| Summary[Log Changes Summary]
    Summary --> Loop[Process Each Change]

    Loop --> IsNew{New Record?}
    IsNew -->|Yes| RecordOnly[Record State Only]
    RecordOnly --> Next

    IsNew -->|No| Match[Match to Ticket]
    Match --> Found{Ticket Found?}

    Found -->|No| LogMiss[Log No Match]
    LogMiss --> Next

    Found -->|Yes| CheckStatus{Status = COMPLIED\nor UNFOUNDED?}

    CheckStatus -->|Yes| Close[Close Ticket]
    Close --> Next

    CheckStatus -->|No| Comment[Add Status Comment]
    Comment --> Next

    Next{More Changes?} -->|Yes| Loop
    Next -->|No| Upsert[Upsert All States]
    Upsert --> Log[Log Sync Results]
    Log --> Done
```

### LLM Ticket Matching Flow

```mermaid
flowchart TD
    Start([Match Request]) --> CacheCheck{Check DB Cache}

    CacheCheck -->|Hit| ReturnCached[Return Cached Match]
    ReturnCached --> Done([Done])

    CacheCheck -->|Miss| ExtIDCheck[External ID Lookup]
    ExtIDCheck --> ExtIDFound{Found?}

    ExtIDFound -->|Yes| CacheExtID[Cache Match]
    CacheExtID --> ReturnExtID[Return Match]
    ReturnExtID --> Done

    ExtIDFound -->|No| LLMEnabled{LLM Enabled?}
    LLMEnabled -->|No| NoMatch[Return No Match]
    NoMatch --> Done

    LLMEnabled -->|Yes| FetchCandidates[Fetch Nearby Tickets\nby Location]
    FetchCandidates --> HasCandidates{Candidates Found?}

    HasCandidates -->|No| QueueReview1[Queue for Review]
    QueueReview1 --> Done

    HasCandidates -->|Yes| CallLLM[Call OpenAI\nwith Prompt]
    CallLLM --> ParseResponse[Parse LLM Response]
    ParseResponse --> ParseOK{Parse OK?}

    ParseOK -->|No| QueueReview2[Queue for Review]
    QueueReview2 --> Done

    ParseOK -->|Yes| Confidence{Confidence Level?}

    Confidence -->|Low/None| QueueReview3[Queue for Review]
    QueueReview3 --> Done

    Confidence -->|High/Medium| SaveMatch[Cache Match Locally]
    SaveMatch --> StampTicket[Stamp Ticket with\nExternal ID]
    StampTicket --> ReturnMatch[Return Match]
    ReturnMatch --> Done
```

### Database Schema

```mermaid
erDiagram
    violation_state {
        text external_id PK
        text activity_id
        text case_no
        text violation_type
        text violation_status
        text date_observed
        text site_address
        jsonb raw_data
        timestamptz last_seen_at
        timestamptz created_at
        int matched_ticket_id
        text match_method
        text match_confidence
        timestamptz matched_at
    }

    inspection_state {
        text unique_key PK
        text case_no
        text inspection_type
        text result
        text scheduled_date
        text completed_date
        text inspector
        jsonb raw_data
        timestamptz last_seen_at
        timestamptz created_at
    }

    sync_log {
        serial id PK
        text sync_type
        timestamptz started_at
        timestamptz completed_at
        int total_records
        int changed_records
        int errors
        text error_message
        jsonb metadata
    }

    review_queue {
        serial id PK
        text external_id
        jsonb violation_data
        jsonb candidate_tickets
        text reason
        text status
        int resolved_ticket_id
        text resolved_by
        timestamptz resolved_at
        timestamptz created_at
    }

    match_log {
        serial id PK
        text external_id
        text match_method
        int candidate_count
        int selected_ticket_id
        text confidence
        text llm_reasoning
        int prompt_tokens
        int completion_tokens
        int duration_ms
        timestamptz created_at
    }

    violation_state ||--o{ match_log : "logs"
    violation_state ||--o{ review_queue : "queued"
```

### Component Architecture

```mermaid
flowchart LR
    subgraph Routes["routes/"]
        webhook["webhook.ts"]
    end

    subgraph Parsers["parsers/"]
        detect["detect-type.ts"]
        violations["violations.ts"]
        inspections["inspections.ts"]
    end

    subgraph Sync["sync/"]
        violationsSync["violations-sync.ts"]
        inspectionsSync["inspections-sync.ts"]
        threefold["threefold.ts"]
    end

    subgraph State["state/"]
        tracker["tracker.ts"]
        reviewQueue["review-queue.ts"]
    end

    subgraph Matching["matching/"]
        ticketMatcher["ticket-matcher.ts"]
        llmPrompt["llm-prompt.ts"]
        types["types.ts"]
    end

    subgraph LLM["llm/"]
        openai["openai.ts"]
    end

    subgraph Utils["utils/"]
        externalId["external-id.ts"]
    end

    webhook --> detect
    webhook --> violations
    webhook --> inspections
    webhook --> violationsSync
    webhook --> inspectionsSync

    violationsSync --> tracker
    violationsSync --> threefold
    violationsSync --> ticketMatcher

    inspectionsSync --> tracker
    inspectionsSync --> threefold

    ticketMatcher --> tracker
    ticketMatcher --> reviewQueue
    ticketMatcher --> openai
    ticketMatcher --> llmPrompt
    ticketMatcher --> threefold

    violations --> externalId
    tracker --> types
```

---

## What It Does

Receives hourly TrakIT email exports from Corona via SendGrid Inbound Parse, extracts CSV attachments (violations, inspections), parses them using TrakIT-specific column mappings, tracks the last-seen state of each record to detect changes, applies Corona's business rules to determine actions, and calls Threefold API to update tickets.

## Supported Reports

| Report | File Pattern | Action |
|--------|--------------|--------|
| Violations | `V_Threefold_Violations_and_Cases.csv` | Close ticket if COMPLIED/UNFOUNDED |
| Inspections | `V_Threefold_CASE_INSPECTIONS.csv` | Add comment to linked tickets |

## External ID Format

Violations are linked to Threefold tickets using this external ID format:

```
violation|{CASE_NO}|{Violation_Type}|{DATE_OBSERVED}

Example: "violation|CC24-1354|STAGNANT WATER|2024-08-27"
```

This format is:
- Readable for debugging
- Queryable with LIKE for case-based lookups (inspections)
- Deterministic (same input = same output)

## Setup

### 1. Railway Setup

1. Create a new project on Railway
2. Add a PostgreSQL database
3. Deploy this repo (connect GitHub)
4. Add environment variables (see below)

### 2. Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Railway Postgres (auto-provided by Railway)
DATABASE_URL=postgresql://...

# Threefold API
THREEFOLD_API_URL=https://app.threefold.io
THREEFOLD_API_TOKEN=your-bearer-token
THREEFOLD_ORG_ID=corona-org-uuid

# Optional: OpenAI for LLM matching
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
LLM_MATCHING_ENABLED=true

# Matching config
MATCHING_RADIUS_METERS=100
MATCHING_LOOKBACK_DAYS=90

# Ticket updates (set to false for dry run)
TICKET_UPDATES_ENABLED=true
```

### 3. SendGrid Inbound Parse

1. Configure a subdomain MX record pointing to SendGrid
2. Set up Inbound Parse to POST to: `https://your-railway-app.up.railway.app/webhook/sendgrid`
3. Configure TrakIT to send hourly exports to the inbound email address

## Development

```bash
# Install dependencies
npm install

# Run locally (requires DATABASE_URL)
npm run dev

# Type check
npm run typecheck

# Build
npm run build
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/webhook/sendgrid` | POST | SendGrid Inbound Parse webhook |

## Database Schema

The service uses Railway Postgres to track state:

- `violation_state` - Last-seen state of each violation
- `inspection_state` - Last-seen state of each inspection
- `sync_log` - Audit log of sync runs
- `review_queue` - Manual review queue for uncertain matches
- `match_log` - Audit log of LLM matching decisions

## Threefold Integration

This service calls Threefold's external API:

- `GET /api/external/ticket-by-reference` - Find ticket by external ID
- `GET /api/external/tickets-by-reference-pattern` - Find tickets by case number
- `POST /api/external/tickets/by-location` - Find tickets near an address
- `POST /api/change-status/external` - Update ticket status
- `POST /api/change-step/external` - Move ticket to workflow step
- `POST /api/comments/external` - Add comment to ticket
- `POST /api/update-external-reference/external` - Stamp ticket with external ID

## Status Mappings

### Violations

| TrakIT Status | Threefold Action |
|---------------|------------------|
| `COMPLIED` | Close ticket |
| `UNFOUNDED` | Close ticket |
| Other | Add status change comment |

### Inspections

All inspection changes add a comment to linked tickets with inspection details.

## Ticket Matching Strategy

The service uses a multi-tier matching strategy:

1. **Cache Check** - Fast path for previously matched violations
2. **External ID Lookup** - Direct lookup if ticket already stamped
3. **LLM Matching** - Uses GPT-4o-mini to match by location + context
4. **Review Queue** - Low-confidence matches queued for manual review
