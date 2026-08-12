import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const profilesTable = pgTable("profiles", {
  address: text("address").primaryKey(),
  username: text("username").notNull().unique(),
  bio: text("bio"),
  avatarUrl: text("avatar_url"),
  twitterHandle: text("twitter_handle"),
  websiteUrl: text("website_url"),
  followersCount: integer("followers_count").notNull().default(0),
  followingCount: integer("following_count").notNull().default(0),
  // Social auth columns (nullable for wallet-only users)
  email: text("email").unique(),
  googleId: text("google_id").unique(),
  authType: text("auth_type").notNull().default("wallet"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProfileSchema = createInsertSchema(profilesTable).omit({
  createdAt: true,
  updatedAt: true,
});

export const updateProfileSchema = insertProfileSchema.partial().omit({ address: true });

export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type UpdateProfile = z.infer<typeof updateProfileSchema>;
export type Profile = typeof profilesTable.$inferSelect;
