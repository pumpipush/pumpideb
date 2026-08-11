/**
 * Deterministic username generator — produces a readable name from a wallet
 * address without any network call. Used in ProfileEditModal and ProfilePage.
 */

const ADJECTIVES = [
  "Swift","Neon","Cyber","Lunar","Solar","Cosmic","Dark","Hyper","Turbo","Iron",
  "Laser","Void","Sonic","Alpha","Omega","Nova","Quantum","Pixel","Atomic","Prism",
  "Shadow","Blazing","Golden","Silver","Stealth","Nitro","Rapid","Apex","Ultra","Infra",
];
const NOUNS = [
  "Ape","Doge","Wolf","Fox","Bear","Eagle","Shark","Tiger","Panda","Hawk",
  "Bull","Lynx","Viper","Cobra","Raven","Drake","Sphinx","Phoenix","Dragon","Jaguar",
  "Falcon","Rhino","Manta","Bison","Badger","Gecko","Mantis","Panther","Raptor","Titan",
];

export function generateUsername(address: string): string {
  const s1 = parseInt(address.slice(2, 10), 16) >>> 0;
  const s2 = parseInt(address.slice(-8), 16) >>> 0;
  const combined = (s1 ^ s2) >>> 0;
  const adj = ADJECTIVES[combined % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(combined / ADJECTIVES.length) % NOUNS.length];
  const num = (s1 % 90) + (s2 % 910);
  return `${adj}${noun}${num}`;
}
