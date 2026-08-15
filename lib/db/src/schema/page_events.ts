import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const pageEventsTable = pgTable("page_events", {
  id:          serial("id").primaryKey(),
  ts:          timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  path:        text("path").notNull(),
  referrer:    text("referrer"),
  ip:          text("ip"),
  userAgent:   text("user_agent"),
  browser:     text("browser"),
  os:          text("os"),
  device:      text("device"),
  sessionId:   text("session_id"),
  userAddress: text("user_address"),
});

export type PageEvent = typeof pageEventsTable.$inferSelect;
export type InsertPageEvent = typeof pageEventsTable.$inferInsert;
