import { pgTable, text, serial, timestamp, boolean, numeric, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tokensTable = pgTable("tokens", {
  id: serial("id").primaryKey(),
  address: text("address").notNull().unique(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  creatorAddress: text("creator_address").notNull(),
  virtualTokenReserves: text("virtual_token_reserves").notNull().default("1000000000000000000000000000"),
  virtualEthReserves: text("virtual_eth_reserves").notNull().default("3000000000000000000000"),
  realTokenReserves: text("real_token_reserves").notNull().default("1000000000000000000000000000"),
  realEthReserves: text("real_eth_reserves").notNull().default("0"),
  totalSupply: text("total_supply").notNull().default("1000000000000000000000000000"),
  marketCapEth: text("market_cap_eth"),
  priceEth: text("price_eth"),
  graduated: boolean("graduated").notNull().default(false),
  graduatedAt: timestamp("graduated_at", { withTimezone: true }),
  volumeEth: text("volume_eth").notNull().default("0"),
  tradeCount: numeric("trade_count").notNull().default("0"),
  holderCount: numeric("holder_count").notNull().default("0"),
  twitterUrl: text("twitter_url"),
  telegramUrl: text("telegram_url"),
  websiteUrl: text("website_url"),
  platform: text("platform").notNull().default("unknown"),
  chain: text("chain").notNull().default("base"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ── Multi-DEX columns (nullable — only set for non-pump.fun tokens) ─────────
  poolAddress:    text("pool_address"),
  quoteMint:      text("quote_mint"),
  liquidityUsd:   doublePrecision("liquidity_usd"),
  priceUsd:       doublePrecision("price_usd"),
  marketCapUsd:   doublePrecision("market_cap_usd"),
  pctChange24h:   doublePrecision("pct_change_24h"),  // 24h price % change; refreshed from Birdeye for DEX tokens
});

export const insertTokenSchema = createInsertSchema(tokensTable).omit({
  id: true,
  createdAt: true,
});
export type InsertToken = z.infer<typeof insertTokenSchema>;
export type Token = typeof tokensTable.$inferSelect;
