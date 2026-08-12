-- Speed up trending query time-range subqueries.
-- The subqueries in GET /tokens?sort=trending do:
--   WHERE timestamp > NOW() - INTERVAL '1 hour'   (and 5m)
--   GROUP BY token_address
-- Without a timestamp-first index the planner does a full seq scan (~1.75 M rows, ~2.2 s each).
-- A (timestamp DESC) index lets the planner do a fast range scan before grouping.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_timestamp
  ON trades (timestamp DESC);

-- Also useful for the fetch24hPctChanges query which filters timestamp > 24h
-- and token_address = ANY($1).  A composite (timestamp DESC, token_address) index
-- lets Postgres satisfy both predicates from the index without a heap fetch
-- for the COUNT/DISTINCT ON subqueries.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_timestamp_token
  ON trades (timestamp DESC, token_address);
