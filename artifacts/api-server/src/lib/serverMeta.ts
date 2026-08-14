/**
 * Timestamp recorded the moment this server process started.
 * Used by the "New" token sort to exclude tokens that were already in the
 * database before this session — so the New tab always shows only coins that
 * launched while the server was running, not historical data.
 */
export const SERVER_START_TIME: Date = new Date();
