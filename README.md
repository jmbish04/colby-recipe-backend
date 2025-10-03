# MenuForge Backend

A serverless backend for recipe management and meal planning, built on Cloudflare Workers.

## Features

- 🍳 **Recipe Scraping**: Crawls and renders recipe pages on-demand and scheduled
- 🤖 **AI Enrichment**: Uses Workers AI to normalize recipes and add cooking alternatives
- 🔍 **Smart Search**: Personalized recipe search with user preference learning
- 👥 **Multi-User**: Support for multiple users with favorites, ratings, and profiles
- 📅 **Menu Planning**: AI-powered weekly menu generation
- 💬 **Chat**: Recipe suggestions via AI chat endpoint
- 🗄️ **Storage**: D1 for metadata, R2 for snapshots/images, KV for caching

## Tech Stack

- **Runtime**: Cloudflare Workers (TypeScript)
- **Router**: Hono
- **Database**: D1 (SQLite)
- **Storage**: R2 (Object Storage)
- **Cache**: KV (Key-Value)
- **AI**: Workers AI (@cf/baai/bge-large-en-v1.5, @cf/meta/llama-3.1-70b-instruct)
- **Browser**: Browser Rendering API

## Setup

### Quick Start

1. **Install dependencies**:
```bash
npm install
```

2. **Create D1 database**:
```bash
npx wrangler d1 create menuforge-db
```

Update `wrangler.toml` with the database ID.

3. **Initialize schema**:
```bash
npx wrangler d1 execute menuforge-db --file=./src/sql/schema.sql
```

4. **Create KV namespace**:
```bash
npx wrangler kv:namespace create KV
```

Update `wrangler.toml` with the KV namespace ID.

5. **Create R2 buckets**:
```bash
npx wrangler r2 bucket create menuforge-snapshots
npx wrangler r2 bucket create menuforge-images
```

6. **Deploy**:
```bash
npm run deploy
```

## Development

Run locally:
```bash
npm run dev
```

## Detailed Setup Instructions

### Prerequisites

- Node.js 18+ (recommended: use [nvm](https://github.com/nvm-sh/nvm))
- A Cloudflare account with Workers enabled
- Wrangler CLI (installed via npm install)

### Step-by-Step Setup

1. **Clone and install dependencies**:
```bash
git clone <your-repo>
cd <project-directory>
npm install
```

2. **Login to Cloudflare**:
```bash
npx wrangler login
```

3. **Create D1 database**:
```bash
npx wrangler d1 create menuforge-db
```

Copy the output `database_id` and update `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "menuforge-db"
database_id = "YOUR_DATABASE_ID_HERE"  # Replace this
```

4. **Initialize database schema**:
```bash
npx wrangler d1 execute menuforge-db --file=./src/sql/schema.sql
```

5. **Create KV namespace**:
```bash
npx wrangler kv:namespace create KV
```

Copy the output `id` and update `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_ID_HERE"  # Replace this
```

6. **Create R2 buckets**:
```bash
npx wrangler r2 bucket create menuforge-snapshots
npx wrangler r2 bucket create menuforge-images
```

7. **Deploy to Cloudflare**:
```bash
npm run deploy
```

Your worker will be available at `https://menuforge.YOUR_SUBDOMAIN.workers.dev`

### Local Development

To run the worker locally with hot reloading:

```bash
npm run dev
```

This will start the worker on `http://localhost:8787`

**Note**: Local development will use simulated bindings. For full functionality, you may need to test against the deployed version.

## Project Structure

```
menuforge/
├── src/
│   ├── worker.ts           # Main worker entry point with Hono routes
│   ├── lib/
│   │   ├── auth.ts         # Authentication (CF Access + dev tokens)
│   │   ├── ai.ts           # Workers AI helpers (embed, enrich, chat)
│   │   ├── scrape.ts       # Web scraping and recipe extraction
│   │   └── profile.ts      # User preference learning and ranking
│   └── sql/
│       └── schema.sql      # D1 database schema
├── wrangler.toml           # Cloudflare Workers configuration
├── package.json
├── tsconfig.json
└── README.md
```

## Key Concepts

### Recipe Enrichment

When a recipe is scraped:
1. HTML is fetched and JSON-LD data is extracted
2. Workers AI normalizes the recipe into a consistent format
3. AI generates alternative cooking methods (Tokit, air fryer, rice cooker, bread machine)
4. Original HTML and images are stored in R2
5. Metadata is stored in D1

### User Learning

The system learns user preferences through events:
- **click_tile**: +0.1 weight
- **open_full**: +0.3 weight
- **favorite**: +1.2 weight
- **cooked/add_to_menu**: +1.6 weight
- **rated**: -2 to +2 weight based on stars (1-5)

Weights decay exponentially with a 90-day half-life, then are clamped to [-3, +3].

### Search Ranking

Search results are ranked by:
1. **Freshness**: Newer recipes score higher
2. **Tag preferences**: User's tag weights × 0.2
3. **Cuisine preferences**: User's cuisine weights × 0.3

### Scheduled Crawling

Every 3 hours:
1. Load seed URLs from KV (or use defaults)
2. Discover recipe links from seeds
3. Enqueue up to 5 links per seed
4. Process up to 20 queued URLs
5. Mark as done or error

## API Endpoints

### Authentication

#### Dev Login
```bash
curl -X POST https://menuforge.workers.dev/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"user_id": "justin", "name": "Justin", "email": "justin@example.com"}'
```

Returns: `{"token": "abc123..."}`

### Recipes

#### Scan Single Recipe
```bash
curl -X POST https://menuforge.workers.dev/api/recipes/scan \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.seriouseats.com/recipes/some-recipe"}'
```

#### Batch Scan
```bash
curl -X POST https://menuforge.workers.dev/api/recipes/batch-scan \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://www.seriouseats.com/recipes/recipe1",
      "https://www.kingarthurbaking.com/recipes/banana-bread",
      "https://www.budgetbytes.com/chocolate-cake"
    ]
  }'
```

#### List Recipes
```bash
# Basic list
curl https://menuforge.workers.dev/api/recipes

# With search
curl "https://menuforge.workers.dev/api/recipes?q=banana&limit=10"

# With authentication for personalized ranking
curl https://menuforge.workers.dev/api/recipes \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### Get Recipe Details
```bash
curl https://menuforge.workers.dev/api/recipes/RECIPE_ID
```

### Favorites

#### Add Favorite
```bash
curl -X POST https://menuforge.workers.dev/api/favorites/RECIPE_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### Remove Favorite
```bash
curl -X DELETE https://menuforge.workers.dev/api/favorites/RECIPE_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Ratings

#### Rate Recipe
```bash
curl -X POST https://menuforge.workers.dev/api/recipes/RECIPE_ID/rating \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "stars": 5,
    "notes": "Amazing recipe!",
    "cooked_at": "2025-10-01"
  }'
```

#### Get Rating
```bash
curl https://menuforge.workers.dev/api/recipes/RECIPE_ID/rating \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Events

#### Track Event
```bash
curl -X POST https://menuforge.workers.dev/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "click_tile",
    "recipe_id": "RECIPE_ID"
  }'
```

Event types: `click_tile`, `open_full`, `favorite`, `rated`, `cooked`, `add_to_menu`

### Menus

#### Generate Menu
```bash
curl -X POST https://menuforge.workers.dev/api/menus/generate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "week_start": "2025-10-06",
    "theme": "vegetarian week",
    "excluded_recipe_ids": ["RECIPE_ID_1"]
  }'
```
`theme` steers the AI prompt (e.g., "vegetarian week", "Mediterranean reset"), while `excluded_recipe_ids` prevents recycled recipes when regenerating a day.

#### Get Menu
```bash
curl https://menuforge.workers.dev/api/menus/MENU_ID
```

#### Update Menu
```bash
curl -X PUT https://menuforge.workers.dev/api/menus/MENU_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"day": "Monday", "meal": "dinner", "recipe_id": "RECIPE_ID_1"},
      {"day": "Tuesday", "meal": "dinner", "recipe_id": "RECIPE_ID_2"}
    ]
  }'
```

### Search

#### Search Suggestions
```bash
curl "https://menuforge.workers.dev/api/search/suggest?q=banana"
```

#### Enqueue URLs for Scraping
```bash
curl -X POST https://menuforge.workers.dev/api/search/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://www.example.com/recipe1",
      "https://www.example.com/recipe2"
    ]
  }'
```

### Pantry

#### List Pantry Items
```bash
curl https://menuforge.workers.dev/api/pantry \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### Add Pantry Item
```bash
curl -X POST https://menuforge.workers.dev/api/pantry \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ingredientName": "olive oil", "quantity": "500", "unit": "ml"}'
```

#### Update Pantry Item
```bash
curl -X PUT https://menuforge.workers.dev/api/pantry/ITEM_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quantity": "1", "unit": "bottle"}'
```

#### Remove Pantry Item
```bash
curl -X DELETE https://menuforge.workers.dev/api/pantry/ITEM_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Shopping Lists

#### Generate Pantry-Aware Shopping List
```bash
curl -X POST https://menuforge.workers.dev/api/menus/MENU_ID/shopping-list \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Print

#### Download Recipe as HTML
```bash
curl "https://menuforge.workers.dev/api/recipes/RECIPE_ID/print" \
  -o recipe.html

# Or with format parameter (pdf format not yet implemented)
curl "https://menuforge.workers.dev/api/recipes/RECIPE_ID/print?format=html" \
  -o recipe.html
```

### Chat

#### Chat with AI
```bash
curl -X POST https://menuforge.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "messages": [
      {"role": "user", "content": "Suggest me a recipe for dinner tonight"}
    ]
  }'
```

## Acceptance Testing

Complete test flow:

```bash
# 1. Dev login for two users
TOKEN_JUSTIN=$(curl -X POST https://menuforge.workers.dev/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"user_id": "justin", "name": "Justin"}' | jq -r '.token')

TOKEN_PARTNER=$(curl -X POST https://menuforge.workers.dev/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"user_id": "partner", "name": "Partner"}' | jq -r '.token')

# 2. Scan recipes
curl -X POST https://menuforge.workers.dev/api/recipes/batch-scan \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://www.seriouseats.com/recipes/asian-recipe",
      "https://www.kingarthurbaking.com/recipes/banana-bread",
      "https://www.budgetbytes.com/chocolate-cake"
    ]
  }'

# 3. List recipes (note: replace RECIPE_IDs with actual IDs from scan)
curl https://menuforge.workers.dev/api/recipes

# 4. Justin favorites and rates a recipe
curl -X POST https://menuforge.workers.dev/api/favorites/RECIPE_ID_1 \
  -H "Authorization: Bearer $TOKEN_JUSTIN"

curl -X POST https://menuforge.workers.dev/api/recipes/RECIPE_ID_1/rating \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{"stars": 5, "notes": "Love it!"}'

# 5. Partner rates same recipe differently
curl -X POST https://menuforge.workers.dev/api/recipes/RECIPE_ID_1/rating \
  -H "Authorization: Bearer $TOKEN_PARTNER" \
  -H "Content-Type: application/json" \
  -d '{"stars": 3, "notes": "It was okay"}'

# 6. List recipes again with Justin's token - should show personalized ranking
curl https://menuforge.workers.dev/api/recipes \
  -H "Authorization: Bearer $TOKEN_JUSTIN"

# 7. Generate menu
MENU_ID=$(curl -X POST https://menuforge.workers.dev/api/menus/generate \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{"week_start": "2025-10-06"}' | jq -r '.id')

curl https://menuforge.workers.dev/api/menus/$MENU_ID

# 8. Generate printable HTML
curl "$BASE_URL/api/recipes/RECIPE_ID_1/print" -o recipe.html

# 9. Track events
curl -X POST https://menuforge.workers.dev/api/events \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{"event_type": "cooked", "recipe_id": "RECIPE_ID_1"}'

curl -X POST https://menuforge.workers.dev/api/events \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{"event_type": "open_full", "recipe_id": "RECIPE_ID_2"}'
```

## Scheduled Jobs

The worker runs a cron job every 3 hours to:
1. Discover recipe links from seed sources
2. Process up to 20 queued URLs
3. Scrape and enrich recipes
4. Store in D1 and R2

## Architecture

### Data Flow

1. **Scraping**: Browser Rendering → HTML extraction → JSON-LD parsing
2. **Enrichment**: AI normalization → Alternative cooking methods
3. **Storage**: R2 (snapshots/images) + D1 (metadata)
4. **Learning**: User events → Profile computation → Ranking boost
5. **Search**: Keyword filter + User profile scoring

### Database Schema

- `recipes`: Main recipe data with normalized fields
- `users`: User accounts
- `favorites`: User favorites
- `ratings`: User ratings (1-5 stars)
- `events`: Activity tracking for learning
- `user_profiles`: Computed preferences
- `menus`: Weekly meal plans
- `crawl_queue`: URL queue for scheduled scraping
- `snapshots`: R2 keys for stored content

### KV Keys

- `kv:sess:{token}`: User sessions
- `kv:user-prof:{user_id}`: Cached user profiles
- `source-seeds`: Recipe discovery URLs
- `kv:search-cache:{query}`: Search suggestions cache

## License

MIT
