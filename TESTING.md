# MenuForge Testing Guide

This document provides comprehensive testing scenarios for the MenuForge backend.

## Prerequisites

- Deploy the worker to Cloudflare or run locally with `npm run dev`
- Set `BASE_URL` environment variable to your worker URL
- Have `curl` and `jq` installed for JSON processing

```bash
# For deployed version
export BASE_URL="https://menuforge.YOUR_SUBDOMAIN.workers.dev"

# For local development
export BASE_URL="http://localhost:8787"
```

## Acceptance Test Suite

### 1. Dev Login for Two Users

Create two user accounts to test multi-user functionality:

```bash
# Login as Justin
TOKEN_JUSTIN=$(curl -s -X POST $BASE_URL/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"user_id": "justin", "name": "Justin", "email": "justin@example.com"}' | jq -r '.token')

echo "Justin's token: $TOKEN_JUSTIN"

# Login as Partner
TOKEN_PARTNER=$(curl -s -X POST $BASE_URL/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"user_id": "partner", "name": "Partner", "email": "partner@example.com"}' | jq -r '.token')

echo "Partner's token: $TOKEN_PARTNER"
```

### 2. Scan Multiple Recipes

Scan recipes from different sources including Asian cuisine, banana bread, and desserts:

```bash
# Batch scan recipes
curl -s -X POST $BASE_URL/api/recipes/batch-scan \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://www.seriouseats.com/recipes/2014/09/easy-italian-amercian-red-sauce-recipe.html",
      "https://www.kingarthurbaking.com/recipes/banana-bread-recipe",
      "https://www.budgetbytes.com/basic-chocolate-cake/"
    ]
  }' | jq '.'

# Single scan example
curl -s -X POST $BASE_URL/api/recipes/scan \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.seriouseats.com/thai-style-chicken-recipe"}' | jq '.'
```

**Expected Result**: Each URL should return a recipe ID or an error message.

### 3. List Recipes

List all recipes and verify they're returned as tiles:

```bash
# List all recipes (unauthenticated)
curl -s "$BASE_URL/api/recipes" | jq '.recipes[] | {id, title, cuisine, tags}'

# List with search filter
curl -s "$BASE_URL/api/recipes?q=banana&limit=10" | jq '.recipes[] | {id, title}'

# List with tag filter
curl -s "$BASE_URL/api/recipes?tag=dessert" | jq '.recipes[] | {id, title, tags}'

# List with cuisine filter
curl -s "$BASE_URL/api/recipes?cuisine=Asian" | jq '.recipes[] | {id, title, cuisine}'
```

**Expected Result**: JSON array of recipe objects with id, title, image, cuisine, and tags fields.

### 4. Favorite and Rate Recipes

Test favorites and ratings with both users:

```bash
# Get a recipe ID (use one from the list)
RECIPE_ID_1=$(curl -s "$BASE_URL/api/recipes?limit=1" | jq -r '.recipes[0].id')
echo "Testing with recipe ID: $RECIPE_ID_1"

# Justin favorites the recipe
curl -s -X POST "$BASE_URL/api/favorites/$RECIPE_ID_1" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" | jq '.'

# Justin rates it 5 stars
curl -s -X POST "$BASE_URL/api/recipes/$RECIPE_ID_1/rating" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{
    "stars": 5,
    "notes": "Absolutely delicious! Made it twice this week.",
    "cooked_at": "2025-10-01"
  }' | jq '.'

# Partner rates the same recipe differently
curl -s -X POST "$BASE_URL/api/recipes/$RECIPE_ID_1/rating" \
  -H "Authorization: Bearer $TOKEN_PARTNER" \
  -H "Content-Type: application/json" \
  -d '{
    "stars": 3,
    "notes": "It was okay, nothing special."
  }' | jq '.'

# Verify ratings
curl -s "$BASE_URL/api/recipes/$RECIPE_ID_1/rating" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" | jq '.'

curl -s "$BASE_URL/api/recipes/$RECIPE_ID_1/rating" \
  -H "Authorization: Bearer $TOKEN_PARTNER" | jq '.'
```

**Expected Result**: Each user should have their own rating stored and returned.

### 5. Test Personalized Ranking

Verify that recipe ordering differs based on user preferences:

```bash
# List recipes as Justin (should show boosted ranking for favorited/rated items)
echo "Justin's personalized results:"
curl -s "$BASE_URL/api/recipes?limit=5" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" | jq '.recipes[] | {id, title}'

# List recipes as Partner (different ranking)
echo "Partner's personalized results:"
curl -s "$BASE_URL/api/recipes?limit=5" \
  -H "Authorization: Bearer $TOKEN_PARTNER" | jq '.recipes[] | {id, title}'

# List recipes anonymously (no personalization)
echo "Anonymous results:"
curl -s "$BASE_URL/api/recipes?limit=5" | jq '.recipes[] | {id, title}'
```

**Expected Result**: The order should differ based on user preferences. Recipes that Justin favorited/rated highly should appear higher in Justin's results.

### 6. Generate and Fetch Menu

Create a weekly menu:

```bash
# Generate menu for Justin
MENU_RESPONSE=$(curl -s -X POST $BASE_URL/api/menus/generate \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{"week_start": "2025-10-06"}')

MENU_ID=$(echo $MENU_RESPONSE | jq -r '.id')
echo "Generated menu ID: $MENU_ID"
echo $MENU_RESPONSE | jq '.'

# Fetch the menu
curl -s "$BASE_URL/api/menus/$MENU_ID" | jq '.menu'

# Update the menu
curl -s -X PUT "$BASE_URL/api/menus/$MENU_ID" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d "{
    \"items\": [
      {\"day\": \"Monday\", \"meal\": \"dinner\", \"recipe_id\": \"$RECIPE_ID_1\"},
      {\"day\": \"Tuesday\", \"meal\": \"dinner\", \"recipe_id\": \"$RECIPE_ID_1\"}
    ]
  }" | jq '.'
```

**Expected Result**: Menu with 7 diverse recipes for the week, properly stored and retrievable.

### 7. Generate Recipe PDF

Download a recipe as a printable document:

```bash
# Download recipe as PDF/HTML
curl -s "$BASE_URL/api/recipes/$RECIPE_ID_1/print.pdf?size=letter" \
  -o /tmp/recipe.html

# Check if file was created
ls -lh /tmp/recipe.html
```

**Expected Result**: HTML file (or PDF in production) containing the formatted recipe.

### 8. Track Events

Post various user interaction events:

```bash
# Track "cooked" event
curl -s -X POST $BASE_URL/api/events \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d "{
    \"event_type\": \"cooked\",
    \"recipe_id\": \"$RECIPE_ID_1\"
  }" | jq '.'

# Track "open_full" event
curl -s -X POST $BASE_URL/api/events \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d "{
    \"event_type\": \"open_full\",
    \"recipe_id\": \"$RECIPE_ID_1\"
  }" | jq '.'

# Track "click_tile" event
curl -s -X POST $BASE_URL/api/events \
  -H "Content-Type: application/json" \
  -d "{
    \"event_type\": \"click_tile\",
    \"recipe_id\": \"$RECIPE_ID_1\"
  }" | jq '.'

# Track "add_to_menu" event
curl -s -X POST $BASE_URL/api/events \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d "{
    \"event_type\": \"add_to_menu\",
    \"recipe_id\": \"$RECIPE_ID_1\"
  }" | jq '.'
```

**Expected Result**: All events should be recorded successfully.

### 9. Search Functionality

Test search suggestions and scraping:

```bash
# Get search suggestions
curl -s "$BASE_URL/api/search/suggest?q=choc" | jq '.'

curl -s "$BASE_URL/api/search/suggest?q=banana" | jq '.'

# Enqueue URLs for scraping
curl -s -X POST $BASE_URL/api/search/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://www.seriouseats.com/recipes/2015/03/chicken-recipe.html"
    ]
  }' | jq '.'

# Trigger seed-based discovery
curl -s -X POST $BASE_URL/api/search/scrape \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.'
```

**Expected Result**: Suggestions should be cached and returned. URLs should be enqueued for processing.

### 10. Chat with AI

Test the AI chat endpoint:

```bash
# Chat as Justin (with preferences)
curl -s -X POST $BASE_URL/api/chat \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Suggest a recipe for dinner tonight"}
    ]
  }'

# Chat anonymously
curl -s -X POST $BASE_URL/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "What is a good dessert recipe?"}
    ]
  }'
```

**Expected Result**: Streaming response from Workers AI with recipe suggestions.

### 11. Get Recipe Details

Fetch full recipe with alternatives:

```bash
curl -s "$BASE_URL/api/recipes/$RECIPE_ID_1" | jq '{
  id: .recipe.id,
  title: .recipe.title,
  ingredients: .recipe.ingredients_json | fromjson,
  steps: .recipe.steps_json | fromjson,
  alternatives: .recipe.alternatives_json | fromjson,
  confidence: .recipe.confidence
}'
```

**Expected Result**: Full recipe with normalized fields, original source blocks, and alternative cooking methods.

### 12. Remove Favorite

Test unfavoriting:

```bash
# Remove favorite
curl -s -X DELETE "$BASE_URL/api/favorites/$RECIPE_ID_1" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" | jq '.'

# Verify it's removed (should not appear in favorites list)
# Note: You would need a GET /api/favorites endpoint to verify this
```

**Expected Result**: Favorite should be removed successfully.

## Complete Test Script

Run all tests in sequence:

```bash
#!/bin/bash
set -e

# Set base URL
export BASE_URL="${BASE_URL:-http://localhost:8787}"

echo "Testing MenuForge Backend at $BASE_URL"
echo "========================================"

# 1. Login
echo "1. Logging in users..."
TOKEN_JUSTIN=$(curl -s -X POST $BASE_URL/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"user_id": "justin", "name": "Justin"}' | jq -r '.token')
echo "✓ Justin logged in"

TOKEN_PARTNER=$(curl -s -X POST $BASE_URL/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"user_id": "partner", "name": "Partner"}' | jq -r '.token')
echo "✓ Partner logged in"

# 2. Scan recipes
echo "2. Scanning recipes..."
curl -s -X POST $BASE_URL/api/recipes/scan \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.seriouseats.com/recipes/2014/09/easy-italian-amercian-red-sauce-recipe.html"}' > /dev/null
echo "✓ Recipe scanned"

# 3. List recipes
echo "3. Listing recipes..."
RECIPE_COUNT=$(curl -s "$BASE_URL/api/recipes?limit=5" | jq '.recipes | length')
echo "✓ Found $RECIPE_COUNT recipes"

RECIPE_ID=$(curl -s "$BASE_URL/api/recipes?limit=1" | jq -r '.recipes[0].id')
echo "✓ Using recipe ID: $RECIPE_ID"

# 4. Favorite and rate
echo "4. Testing favorites and ratings..."
curl -s -X POST "$BASE_URL/api/favorites/$RECIPE_ID" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" > /dev/null
echo "✓ Justin favorited recipe"

curl -s -X POST "$BASE_URL/api/recipes/$RECIPE_ID/rating" \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{"stars": 5, "notes": "Great!"}' > /dev/null
echo "✓ Justin rated recipe 5 stars"

curl -s -X POST "$BASE_URL/api/recipes/$RECIPE_ID/rating" \
  -H "Authorization: Bearer $TOKEN_PARTNER" \
  -H "Content-Type: application/json" \
  -d '{"stars": 3, "notes": "OK"}' > /dev/null
echo "✓ Partner rated recipe 3 stars"

# 5. Generate menu
echo "5. Generating menu..."
MENU_ID=$(curl -s -X POST $BASE_URL/api/menus/generate \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d '{"week_start": "2025-10-06"}' | jq -r '.id')
echo "✓ Menu generated: $MENU_ID"

# 6. Track events
echo "6. Tracking events..."
curl -s -X POST $BASE_URL/api/events \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d "{\"event_type\": \"cooked\", \"recipe_id\": \"$RECIPE_ID\"}" > /dev/null
echo "✓ Cooked event tracked"

curl -s -X POST $BASE_URL/api/events \
  -H "Authorization: Bearer $TOKEN_JUSTIN" \
  -H "Content-Type: application/json" \
  -d "{\"event_type\": \"open_full\", \"recipe_id\": \"$RECIPE_ID\"}" > /dev/null
echo "✓ Open full event tracked"

echo ""
echo "All tests completed successfully! ✓"
```

Save this script as `test.sh`, make it executable with `chmod +x test.sh`, and run it.

## Testing Checklist

- [ ] Dev login creates sessions and returns tokens
- [ ] Recipe scanning extracts JSON-LD and enriches with AI
- [ ] Batch scanning processes multiple URLs
- [ ] Recipe listing returns tiles with proper fields
- [ ] Search filtering works (query, tag, cuisine)
- [ ] Favorites can be added and removed
- [ ] Ratings can be created and updated
- [ ] User-specific ratings are returned correctly
- [ ] Personalized ranking differs between users
- [ ] Events are tracked and stored
- [ ] Menu generation creates 7 diverse recipes
- [ ] Menus can be fetched and updated
- [ ] Search suggestions are cached
- [ ] PDF/print generation works
- [ ] Chat endpoint responds with AI
- [ ] Scheduled cron job processes queue (manual verification)

## Notes

- Some tests may fail if recipe URLs are unavailable or have changed
- The scraping and AI enrichment may take 10-30 seconds per recipe
- Profile recomputation has a 60-second debounce
- Scheduled jobs run every 3 hours automatically
- Local development uses simulated bindings (some features may differ from production)

## Troubleshooting

### "Database not found" error
Run: `npx wrangler d1 execute menuforge-db --file=./src/sql/schema.sql`

### "KV namespace not found" error
Check that your KV namespace ID in `wrangler.toml` matches the created namespace

### "AI model error"
Ensure Workers AI is enabled for your account and the model names in `wrangler.toml` are correct

### CORS errors
The worker includes CORS headers for all origins. Check browser console for specific errors.
