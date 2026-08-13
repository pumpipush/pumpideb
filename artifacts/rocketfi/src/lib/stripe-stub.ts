// Empty stub for @stripe/stripe-js — pulled in as a transitive dependency
// by @privy-io/react-auth via @stripe/crypto, but never actually used
// because we disable Privy's embedded wallets (createOnLogin: 'off').
export const loadStripe = () => Promise.resolve(null);
export default { loadStripe };
