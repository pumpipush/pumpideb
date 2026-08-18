/**
 * Pumpi design tokens — dark crypto theme.
 * Synced from the rocketfi web artifact (index.css → hex conversion).
 */

const colors = {
  light: {
    // Core surfaces
    background: '#0d0e14',
    foreground: '#ffffff',

    // Cards / elevated surfaces
    card: '#13141a',
    cardForeground: '#ffffff',

    // Primary action — neon green
    primary: '#9aed2c',
    primaryForeground: '#000000',

    // Secondary surfaces
    secondary: 'rgba(255,255,255,0.06)',
    secondaryForeground: '#ffffff',

    // Muted / subdued
    muted: 'rgba(255,255,255,0.06)',
    mutedForeground: 'rgba(255,255,255,0.4)',

    // Accent highlights
    accent: 'rgba(154,237,44,0.12)',
    accentForeground: '#9aed2c',

    // Destructive / error
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    // Borders and inputs
    border: 'rgba(255,255,255,0.07)',
    input: 'rgba(255,255,255,0.06)',

    // Legacy aliases
    text: '#ffffff',
    tint: '#9aed2c',
  },

  radius: 12,
};

export default colors;
