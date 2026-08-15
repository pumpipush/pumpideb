import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatSol(lamports: number): string {
  return (lamports / 1e9).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

export function formatNumber(num: number): string {
  return num.toLocaleString();
}

export function formatAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
