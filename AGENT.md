### **`AGENT.md`**

**Source of truth for automation and humans working in this repo.**
When behavior changes, update this file together with `public/index.html` and `public/openapi.json`.

#### **What this repo is**

  * A Cloudflare Worker (TypeScript, ESM) that powers the MenuForge AI recipe backend.
  * Provides a JSON API under `/api/*` for recipe ingestion, advanced personalization, user management, and agent-driven meal planning.
  * The API is protected by a `WORKER_API_KEY` (sent via `X-API-Key` or `Authorization: Bearer`).
  * Serves a static UI for testing and documentation from the `/public` directory.

-----

#### **Non-negotiables**

  * Keep `public/index.html` and `public/openapi.json` in sync with the API in the same PR.
  * Run `npm run typecheck` and `npm test` successfully before merging. CI enforces this.
  * Preserve verbose structured logging to the `request_logs` table for observability via `/api/logs`.
  * Do not reduce observability bindings without approval.

-----

#### **Layout**

```
/src/
├── ai.ts                 # Workers AI helpers (chat, embeddings, normalization)
├── auth.ts               # API key authentication middleware
├── db.ts                 # D1 database helpers for all data operations
├── env.ts                # Cloudflare binding interfaces
├── types.ts              # Shared domain types for the application
└── worker.ts             # Main Hono router and API endpoint definitions
/migrations/
├── 0001_...sql           # Initial schema
└── 0002_enhanced_schema.sql # Schema for personalization and agentic features
/public/
├── index.html            # Static API tester UI
└── openapi.json          # OpenAPI 3.0 schema
/tests/
└── worker.test.ts        # Vitest worker tests
wrangler.toml             # Worker configuration
```

-----

#### **Core Concepts & Agentic Capabilities**

This backend is designed around a set of intelligent, agentic capabilities that leverage a rich understanding of user context.

1.  **Deep Personalization**: The system moves beyond simple likes. It tracks explicit preferences (`user_prefs`) like allergies and dietary restrictions, alongside implicit signals (`events` table) like viewing, cooking, or skipping recipes. This data feeds a `UserProfile` model that powers a dynamic recipe ranking score.

2.  **AI Menu Planner (`POST /api/menus/generate-ai`)**: This agent acts as an automated meal planner. It considers a user's entire profile—preferences, past ratings, and recent events—to construct a detailed prompt for an LLM, asking it to generate a diverse, compliant 7-day menu. It then finds those recipes in the database and saves the plan.

3.  **Pantry-Aware Shopping Lists (`POST /api/menus/{id}/shopping-list`)**: After a menu is created, this agent can generate a shopping list. It cross-references the required ingredients for all recipes in the menu with the items currently in the user's `pantry_items` table, producing a list of only what's needed.

4.  **Context-Rich AI Chat (`POST /api/chat/ingredients`)**: The chat agent has access to the user's full context. When asked for suggestions, its prompt is enriched with pantry contents, dietary needs, allergies, and a summary of recent user activity, leading to highly relevant and useful recipe ideas.

-----

#### **Database**

The database is structured to support these agentic features:

  * **`users`**: The central table for user identity.
  * **`recipes`**: Stores normalized, structured recipe data.
  * **`user_prefs`**: A rich table for explicit user preferences, including `dietary_restrictions`, `allergies`, and `skill_level`.
  * **`favorites` & `ratings`**: Capture strong, explicit user feedback.
  * **`events`**: Logs implicit user interactions (`view`, `cook`, `skip`) for learning latent preferences.
  * **`menus` & `menu_items`**: Manages weekly meal plans.
  * **`pantry_items`**: Tracks ingredients a user has on hand.
  * **`shopping_lists` & `shopping_list_items`**: Stores auto-generated shopping lists.
  * **`user_agents`**: A forward-looking table to configure and manage different types of agents for each user.
  * **`request_logs`**: Provides observability for all API requests.

-----

#### **Endpoints (must update docs + UI + tests when changing)**

**User & Preferences**

  * `GET /api/prefs?userId={id}`: Fetch detailed personalization preferences for a user.
  * `PUT /api/prefs`: Upsert user preferences.

**Recipe Interaction**

  * `POST /api/recipes/{id}/favorite`: Add a recipe to favorites.
  * `DELETE /api/recipes/{id}/favorite`: Remove a recipe from favorites.
  * `POST /api/recipes/{id}/rating`: Create or update a rating (1-5 stars, notes).
  * `POST /api/events`: Log a user interaction event (e.g., `{ "eventType": "cook", "recipeId": "..." }`).

**Menu Planning**

  * `POST /api/menus`: Create a new weekly menu with a set of `menu_items`.
  * `GET /api/menus/{id}`: Retrieve a specific menu and its associated recipes.
  * `POST /api/menus/generate-ai`: **(Agentic)** Trigger the AI to generate and save a new 7-day menu based on user profile.

**Pantry & Shopping**

  * `GET /api/pantry`: Get all items in the current user's pantry.
  * `POST /api/pantry`: Add a new item to the pantry.
  * `GET /api/shopping-lists/{id}`: Get a specific shopping list and its items.
  * `POST /api/menus/{id}/shopping-list`: **(Agentic)** Generate a pantry-aware shopping list for a given menu.

**AI & Ingestion**

  * `POST /api/chat/ingredients`: Get context-aware recipe suggestions from a list of ingredients.
  * `POST /api/ingest/url`: Ingest a recipe from a URL.
  * `POST /api/ingest/image`: Ingest a recipe from an image using OCR.
  * `POST /api/transcribe`: Transcribe audio (e.g., a voice memo of pantry items).

**Utility**

  * `GET /api/logs`: Fetch structured request logs for debugging and monitoring.

-----

#### **Testing & Quality**

  * Vitest tests live in `/tests`. Use worker pools and mocks for bindings.
  * `npm run typecheck` and `npm test` must pass before opening a PR.
  * Maintain strict TypeScript settings.
  * Use Web APIs where possible; avoid Node-only APIs.

-----

#### **Do / Don’t**

  * **Do** keep docs (`AGENT.md`, `openapi.json`) and the UI (`index.html`) in lock-step with implementation changes.
  * **Do** sanitize all external data and user input.
  * **Don’t** commit secrets (`.dev.vars`).
  * **Don’t** disable or reduce observability features without explicit approval.
