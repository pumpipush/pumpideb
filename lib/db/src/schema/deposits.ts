import { pgTable, serial, text, bigint, timestamp } from "drizzle-orm/pg-core";
import { profilesTable } from "./profiles";

export const depositsTable = pgTable("deposits", {
  id: serial("id").primaryKey(),
  userAddress: text("user_address")
    .notNull()
    .references(() => profilesTable.address, { onDelete: "cascade" }),
  referencePubkey: text("reference_pubkey").notNull().unique(),
  amountLamports: bigint("amount_lamports", { mode: "bigint" }).notNull(),
  /** 'pending' | 'confirmed' | 'expired' */
  status: text("status").notNull().default("pending"),
  txSignature: text("tx_signature"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type Deposit = typeof depositsTable.$inferSelect;
