# MenuForge Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client/Frontend                         │
│                   (Browser, Mobile App, API)                    │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │                 worker.ts (Hono Router)                   │ │
│  │  • 21 API Endpoints                                       │ │
│  │  • Authentication Middleware                              │ │
│  │  • Request/Response Handlers                              │ │
│  └─────┬──────────────────────────┬──────────────┬───────────┘ │
│        │                          │              │             │
│  ┌─────▼──────┐  ┌───────────────▼──┐  ┌───────▼─────────┐   │
│  │   auth.ts  │  │    scrape.ts     │  │   profile.ts    │   │
│  │  CF Access │  │  • Extract HTML  │  │  • Learning     │   │
│  │  Dev Token │  │  • JSON-LD       │  │  • Decay        │   │
│  └────────────┘  │  • Enrich AI     │  │  • Ranking      │   │
│                  └──────────────────┘  └─────────────────┘   │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐│
│  │                        ai.ts                               ││
│  │  • embed() - Generate embeddings                          ││
│  │  • enrichRecipe() - Normalize & add alternatives          ││
│  │  • chat() - Streaming AI responses                        ││
│  └────────────────────────────────────────────────────────────┘│
└───┬───────────┬──────────────┬─────────────┬──────────────────┘
    │           │              │             │
    │ D1        │ KV           │ R2          │ Workers AI
    │           │              │             │
┌───▼──────┐ ┌──▼────────┐ ┌──▼──────────┐ ┌▼─────────────────┐
│ recipes  │ │ kv:sess:* │ │ snapshots/  │ │ Embedding Model  │
│ users    │ │ kv:user-  │ │  *.html     │ │ @cf/baai/bge-    │
│ ratings  │ │   prof:*  │ │  *.png      │ │  large-en-v1.5   │
│ events   │ │ source-   │ │  *.pdf      │ │                  │
│ menus    │ │  seeds    │ ├─────────────┤ │ Chat Model       │
│ queue    │ │ search-   │ │ images/     │ │ @cf/meta/llama-  │
│ ...      │ │  cache    │ │  *.jpg      │ │  3.1-70b-inst    │
└──────────┘ └───────────┘ └─────────────┘ └──────────────────┘
```

## Data Flow

### 1. Recipe Scraping Flow

```
User Request → POST /api/recipes/scan
               ↓
        scrape.ts::scrapeAndExtract()
               ↓
        ┌──────┴──────┐
        │             │
   Fetch HTML    Extract JSON-LD
        │             │
        └──────┬──────┘
               ↓
        ai.ts::enrichRecipe()
               ↓
        Workers AI (Chat Model)
               ↓
        ┌──────┴──────────┬──────────┬──────────┐
        │                 │          │          │
   Normalize Recipe   Generate    Extract    Parse
                      Alts        Tags       Cuisine
        │                 │          │          │
        └──────┬──────────┴──────────┴──────────┘
               ↓
        ┌──────┴──────┐
        │             │
   Store in D1   Store in R2
   (metadata)    (HTML/images)
        │             │
        └──────┬──────┘
               ↓
        Return Recipe ID
```

### 2. Personalized Search Flow

```
User Request → GET /api/recipes?q=banana
               ↓
        Check auth (resolveUser)
               ↓
        ┌──────┴──────┐
        │             │
   Query D1      Get User Profile
   (filter)      (from KV cache)
        │             │
        └──────┬──────┘
               ↓
        Apply Ranking Score
        • Freshness: newer = higher
        • Tags: user_pref * 0.2
        • Cuisine: user_pref * 0.3
               ↓
        Sort by Score
               ↓
        Return Ranked Results
```

### 3. Learning Flow (User Events)

```
User Action → POST /api/events
              ↓
       Store in events table
              ↓
       scheduleProfileRecompute()
              ↓
       Check KV debounce (60s)
              ↓
       profile.ts::recomputeProfile()
              ↓
       ┌──────┴──────┐
       │             │
   Fetch Events   Apply Weights
   (last 1000)    • rated: -2 to +2
       │          • favorite: +1.2
       │          • cooked: +1.6
       │          • open_full: +0.3
       │          • click_tile: +0.1
       │             │
       └──────┬──────┘
              ↓
       Apply Exponential Decay
       (half-life = 90 days)
              ↓
       Clamp to [-3, +3]
              ↓
       ┌──────┴──────┐
       │             │
   Store in D1   Cache in KV
   (persistent)  (fast access)
```

### 4. Scheduled Crawling Flow

```
Cron Trigger (every 3 hours)
              ↓
       scheduled() handler
              ↓
       ┌──────┴──────────┐
       │                 │
   Load Seeds      Get Queued URLs
   (from KV)       (status='queued')
       │                 │
       ▼                 │
   Discover Links        │
   (regex match)         │
       │                 │
       ▼                 │
   Enqueue New URLs      │
       │                 │
       └──────┬──────────┘
              ▼
       Process Queue (up to 20)
              ↓
       For each URL:
       • Mark 'processing'
       • scrapeAndExtract()
       • Mark 'done' or 'error'
              ↓
       Log completion
```

## Component Responsibilities

### worker.ts (Main Entry Point)
- Route handling (Hono)
- Request validation
- Response formatting
- Error handling
- Scheduled job coordination

### lib/auth.ts
- Cloudflare Access JWT validation
- Dev token session management
- User resolution and upsert

### lib/ai.ts
- Workers AI integration
- Embedding generation
- Recipe enrichment
- Chat streaming

### lib/scrape.ts
- HTML fetching
- JSON-LD extraction
- Recipe candidate building
- R2 storage management

### lib/profile.ts
- Event aggregation
- Preference computation
- Exponential decay
- KV caching

## Database Schema

### Core Tables
- **recipes**: Normalized recipe data
- **users**: User accounts
- **favorites**: User-recipe favorites
- **ratings**: User ratings (1-5 stars)
- **events**: Activity tracking

### Learning Tables
- **user_profiles**: Computed preferences
- **menus**: Weekly meal plans
- **menu_members**: Menu sharing

### Infrastructure Tables
- **crawl_queue**: URL processing queue
- **snapshots**: R2 key references
- **recipe_sources**: Domain metadata

## Security Model

### Authentication
1. **Production**: Cloudflare Access
   - JWT validation
   - User info extraction
   - Automatic user upsert

2. **Development**: Dev tokens
   - KV-based sessions
   - 30-day expiration
   - Manual user creation

### Authorization
- Most endpoints: Open (read-only)
- Favorites/Ratings: User-specific
- Menu editing: Owner-only
- Events: Anonymous allowed

### Rate Limiting Considerations
The `/api/events` endpoint allows anonymous event tracking, which could be abused to spam the D1 database. For production deployment, consider:
- Implementing Cloudflare Rate Limiting rules for anonymous requests
- Adding a simple in-memory rate limiter for anonymous IPs
- Using Cloudflare's Bot Management to filter malicious traffic
- Monitoring D1 storage usage and setting alerts

For this low-risk recipe app, Cloudflare's built-in DDoS protection provides basic protection.

## Performance Optimizations

### Caching Strategy
1. **KV Cache**
   - User profiles (60s debounce)
   - Search suggestions (1hr TTL)
   - Session tokens (30d TTL)

2. **Database Indexing**
   - users(account_id)
   - Primary keys on all tables

### Query Optimization
- Limit queries (default 24 items)
- Indexed filters
- Async profile computation

### AI Optimization
- Streaming responses for chat
- Batch embeddings (future)
- Model selection per task

## Scalability

### Horizontal Scaling
- Stateless workers
- Global edge deployment
- Per-request isolation

### Vertical Limits
- D1: 5GB storage (free tier)
- KV: 1GB storage (free tier)
- R2: 10GB storage (free tier)
- Workers: 100K req/day (free tier)

### Future Enhancements
- Vector search (D1 BLOB + JS cosine)
- Image optimization (Cloudflare Images)
- CDN for R2 objects
- Queue-based processing (Queues)
- Durable Objects for real-time features

## Error Handling

### Scraping Errors
- Queue item marked 'error'
- Error message stored
- Retry logic (future)

### AI Errors
- Fallback to basic structure
- Confidence marked 'low'
- Original data preserved

### Database Errors
- Transaction rollback
- Error response to client
- Logging to Workers Analytics

## Monitoring & Observability

### Built-in
- Workers Analytics
- Real-time logs (wrangler tail)
- Error tracking

### Custom Metrics (Future)
- Event counters
- Scraping success rates
- AI enrichment quality
- User engagement metrics
