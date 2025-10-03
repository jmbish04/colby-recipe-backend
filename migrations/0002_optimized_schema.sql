-- SQL Schema for MenuForge Backend
-- Version: 2.0
-- Description: This schema is designed to support advanced personalization,
-- recipe management, meal planning, and future agentic capabilities.

-- Dropping tables in reverse order of dependency to avoid foreign key constraints.
-- This ensures a clean slate when re-applying the entire migration.
DROP INDEX IF EXISTS idx_user_prefs_user;
DROP TABLE IF EXISTS user_prefs;
DROP TABLE IF EXISTS request_logs;
DROP TABLE IF EXISTS ingestions;
DROP TABLE IF EXISTS tools;
DROP TABLE IF EXISTS shopping_list_items;
DROP TABLE IF EXISTS shopping_lists;
DROP TABLE IF EXISTS pantry_items;
DROP TABLE IF EXISTS menu_items;
DROP TABLE IF EXISTS menus;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS ratings;
DROP TABLE IF EXISTS favorites;
DROP TABLE IF EXISTS recipes;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS user_agents;

---
-- Table: users
-- Purpose: Stores core information about registered users. This is the central
-- table for identifying individuals and linking them to their preferences,
-- activities, and content.
-- Agentic Use: Provides the root identity for all personalized agent actions.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, -- Unique identifier for the user (e.g., from an auth provider)
  email TEXT UNIQUE, -- User's email, used for communication and as a unique identifier
  name TEXT, -- User's display name
  picture_url TEXT, -- URL to the user's profile picture
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- Timestamp of user creation
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) -- Timestamp of the last update to user info
);

---
-- Table: recipes
-- Purpose: The main repository for all recipe data. It stores normalized,
-- structured information extracted from various sources (URLs, images, etc.).
-- This clean, consistent data is crucial for searching, filtering, and
-- processing by AI agents.
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY, -- Unique identifier for the recipe
  source_url TEXT UNIQUE, -- The original URL where the recipe was found
  source_domain TEXT, -- The domain of the source URL for grouping and analysis
  title TEXT NOT NULL, -- The title of the recipe
  description TEXT, -- A brief summary of the recipe
  author TEXT, -- The original author or creator of the recipe
  cuisine TEXT, -- The primary cuisine category (e.g., 'Italian', 'Mexican')
  tags TEXT, -- Comma-separated list of tags (e.g., 'dessert', 'quick', 'vegan')
  hero_image_url TEXT, -- URL for the main image of the recipe
  yield TEXT, -- How many servings the recipe makes
  time_prep_min INTEGER, -- Preparation time in minutes
  time_cook_min INTEGER, -- Cooking time in minutes
  time_total_min INTEGER, -- Total time (prep + cook) in minutes
  ingredients_json TEXT, -- JSON array of ingredient objects
  steps_json TEXT, -- JSON array of instruction step objects
  equipment_json TEXT, -- JSON array of required equipment or tools
  notes TEXT, -- Additional notes or tips about the recipe
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- When the recipe was first added
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) -- When the recipe was last updated
);
-- Indexes to speed up common queries for filtering by cuisine or tags.
CREATE INDEX IF NOT EXISTS idx_recipes_cuisine ON recipes(cuisine);
CREATE INDEX IF NOT EXISTS idx_recipes_tags ON recipes(tags);

---
-- Table: user_prefs
-- Purpose: Stores detailed user preferences to enable deep personalization.
-- This table is the primary source of truth for tailoring recipe suggestions,
-- generating meal plans, and filtering content.
-- Agentic Use: Agents will read from this table to understand a user's
-- explicit constraints and tastes.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY, -- Foreign key linking to the users table
  cuisines TEXT, -- JSON array of favored cuisines (e.g., ["thai", "mexican"])
  disliked_ingredients TEXT, -- JSON array of ingredients to avoid
  favored_tools TEXT, -- JSON array of preferred cooking tools (e.g., ["air_fryer"])
  dietary_restrictions TEXT, -- JSON array of dietary needs (e.g., ["vegetarian"])
  allergies TEXT, -- JSON array of allergens to avoid
  skill_level INTEGER, -- User's self-assessed cooking skill (1-5)
  default_servings INTEGER, -- The number of servings they typically cook for
  notes TEXT, -- Free-text notes for any other preferences
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- Timestamp of the last update
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

---
-- Table: favorites
-- Purpose: Tracks which recipes a user has explicitly marked as a favorite.
-- This is a strong positive signal for the personalization engine.
CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL, -- Foreign key to users
  recipe_id TEXT NOT NULL, -- Foreign key to recipes
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- When the favorite was marked
  PRIMARY KEY (user_id, recipe_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);

---
-- Table: ratings
-- Purpose: Stores user-submitted ratings and reviews for recipes. This provides
-- nuanced feedback (both positive and negative) that is more detailed than a simple favorite.
CREATE TABLE IF NOT EXISTS ratings (
  user_id TEXT NOT NULL, -- Foreign key to users
  recipe_id TEXT NOT NULL, -- Foreign key to recipes
  stars INTEGER CHECK(stars >= 1 AND stars <= 5), -- The star rating from 1 to 5
  notes TEXT, -- User's textual review or notes
  cooked_at DATE, -- The date the user cooked the recipe, for their own tracking
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, recipe_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);

---
-- Table: events
-- Purpose: A log of user interactions with recipes. This table captures implicit
-- feedback (like viewing a recipe) which is vital for machine learning models
-- to discover latent preferences beyond what users explicitly state.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, -- Foreign key to users
  event_type TEXT NOT NULL, -- Type of interaction, e.g., 'view', 'cook', 'skip', 'add_to_menu'
  recipe_id TEXT, -- The recipe associated with the event
  session_id TEXT, -- An identifier for the user's session, to group related events
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);

---
-- Table: menus
-- Purpose: Defines a meal plan, typically for a week. It acts as a container
-- for a collection of scheduled recipes.
CREATE TABLE IF NOT EXISTS menus (
  id TEXT PRIMARY KEY, -- Unique identifier for the menu
  user_id TEXT NOT NULL, -- The user who owns this menu
  title TEXT, -- An optional title for the menu (e.g., "Family Holiday Dinners")
  week_start_date DATE, -- The starting date of the week this menu applies to
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

---
-- Table: menu_items
-- Purpose: An associative table that links a recipe to a specific day and meal
-- type within a menu.
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_id TEXT NOT NULL, -- Foreign key to the menus table
  recipe_id TEXT NOT NULL, -- Foreign key to the recipes table
  day_of_week INTEGER, -- The day of the week (0=Sunday, 1=Monday, ..., 6=Saturday)
  meal_type TEXT, -- The type of meal (e.g., 'breakfast', 'lunch', 'dinner')
  FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);

---
-- Table: pantry_items
-- Purpose: Allows users to track ingredients they currently have on hand.
-- Agentic Use: A "Pantry Manager" agent can use this data to suggest recipes
-- that utilize existing ingredients, reducing food waste. It can also identify
-- what's missing for a planned menu and add it to a shopping list.
CREATE TABLE IF NOT EXISTS pantry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, -- The user who owns this pantry
  ingredient_name TEXT NOT NULL, -- The name of the ingredient
  quantity TEXT, -- The amount of the ingredient (e.g., "200")
  unit TEXT, -- The unit of measurement (e.g., "grams", "cups")
  purchase_date DATE, -- When the item was purchased
  expiry_date DATE, -- When the item is expected to expire
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

---
-- Table: shopping_lists
-- Purpose: Acts as a container for shopping list items, often generated from a menu.
CREATE TABLE IF NOT EXISTS shopping_lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, -- The user who owns the list
  menu_id TEXT, -- The menu this list was generated from (optional)
  title TEXT, -- A title for the list (e.g., "Weekly Groceries")
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE
);

---
-- Table: shopping_list_items
-- Purpose: Stores individual items within a shopping list.
-- Agentic Use: An agent can automatically populate this list by comparing the
-- ingredients required for a menu with the items in the user's pantry.
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id TEXT NOT NULL, -- Foreign key to the shopping_lists table
  ingredient_name TEXT NOT NULL, -- The name of the item to buy
  quantity TEXT, -- The suggested quantity to buy
  unit TEXT, -- The unit of measurement
  is_checked BOOLEAN DEFAULT 0, -- Whether the user has marked this item as purchased
  FOREIGN KEY (list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE
);

---
-- Table: user_agents
-- Purpose: A configuration table to manage and personalize different AI agents
-- for each user. This provides a scalable way to introduce new agentic
-- capabilities and allow users to enable or customize them.
CREATE TABLE IF NOT EXISTS user_agents (
  id TEXT PRIMARY KEY, -- Unique identifier for the agent configuration
  user_id TEXT NOT NULL, -- The user this agent belongs to
  agent_type TEXT NOT NULL, -- The type of agent (e.g., 'menu_planner', 'pantry_manager')
  is_enabled BOOLEAN DEFAULT 1, -- Whether the user has this agent active
  config_json TEXT, -- JSON object for agent-specific settings (e.g., planning frequency)
  last_run_at DATETIME, -- The last time this agent performed an action
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

---
-- Table: ingestions
-- Purpose: Logs the raw input and normalized output of the recipe ingestion
-- process. This is useful for debugging the AI extraction and normalization pipeline.
CREATE TABLE IF NOT EXISTS ingestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL, -- 'url' or 'image'
  source_ref TEXT NOT NULL, -- The URL or filename of the source
  raw TEXT, -- The raw text or HTML from the source
  recipe_json TEXT, -- The resulting normalized recipe as JSON
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

---
-- Table: request_logs
-- Purpose: Stores structured logs for API requests. This provides observability
-- into API performance, usage patterns, and errors.
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, -- Timestamp of the log entry
  level TEXT NOT NULL, -- 'info' or 'error'
  route TEXT NOT NULL, -- The API route that was called
  method TEXT NOT NULL, -- The HTTP method used
  status INTEGER NOT NULL, -- The HTTP status code of the response
  ms INTEGER NOT NULL, -- The duration of the request in milliseconds
  msg TEXT, -- A short message ('ok' or 'error')
  meta TEXT -- A JSON object for additional metadata
);
