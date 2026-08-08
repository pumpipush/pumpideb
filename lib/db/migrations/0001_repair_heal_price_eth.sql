-- Migration: repair price_eth values written by the broken zero-amount heal job.
--
-- The heal job previously stored price_eth WITHOUT dividing by 1000, yielding
-- values 1000× too large (lamports/base_unit instead of SOL/token).  The fix
-- was applied to the code, but any trades already healed before the fix carry
-- corrupt price_eth in the DB.
--
-- Identification heuristic:
--   • platform = 'pump_fun'          — only pump_fun uses the heal job
--   • token_amount <> '0'            — row was healed (not still zero)
--   • price_eth > 0.001              — legitimate pump.fun prices are < ~0.00007
--                                      SOL/token at graduation; anything above
--                                      0.001 is definitively 1000× inflated
--
-- Repair: divide those price_eth values by 1000 to restore SOL/token units.
-- The operation is idempotent: after the division every price will be < 0.001,
-- so re-running this migration has no effect.

UPDATE trades
SET    price_eth = (CAST(price_eth AS DOUBLE PRECISION) / 1000)::text
WHERE  platform     = 'pump_fun'
  AND  token_amount <> '0'
  AND  price_eth IS NOT NULL
  AND  CAST(price_eth AS DOUBLE PRECISION) > 0.001;
