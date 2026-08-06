import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  tokenAddress: text("token_address").notNull(),
  tokenName: text("token_name"),
  tokenSymbol: text("token_symbol"),
  traderAddress: text("trader_address").notNull(),
  isBuy: boolean("is_buy").notNull(),
  ethAmount: text("eth_amount").notNull(),
  tokenAmount: text("token_amount").notNull(),
  priceEth: text("price_eth"),
  txHash: text("tx_hash").notNull().unique(),
  platform: text("platform").notNull().default("unknown"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
