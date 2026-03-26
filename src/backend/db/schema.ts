/**
 * @fileoverview Database schema definitions using drizzle-orm.
 *
 * This file defines the database schema using drizzle-orm.
 * It is structured to provide types and table definitions for the backend application.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Users table definition.
 *
 * Stores the users of the application.
 */
export const users = sqliteTable("users", {
  /**
   * The primary key for the users table.
   */
  id: integer("id").primaryKey(),

  /**
   * The name of the user.
   */
  name: text("name").notNull(),
});
