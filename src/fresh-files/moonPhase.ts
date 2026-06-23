/**
 * Moon phase calculations
 */

export type MoonPhase = 
  | "New Moon"
  | "Waxing Crescent"
  | "First Quarter"
  | "Waxing Gibbous"
  | "Full Moon"
  | "Waning Gibbous"
  | "Last Quarter"
  | "Waning Crescent";

export interface MoonPhaseInfo {
  name: MoonPhase;
  emoji: string;
  phase: number; // 0-1, where 0 = new moon, 0.5 = full moon
}

/**
 * Calculate the moon phase for a given date.
 * Based on the synodic month (lunar cycle) of approximately 29.53 days.
 */
export function getMoonPhase(date: Date): MoonPhaseInfo {
  // Known new moon date: January 6, 2000, 18:14 UTC
  const knownNewMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));
  const synodicMonth = 29.530588853; // Average length of lunar cycle in days
  
  // Calculate elapsed time in days
  const elapsed = (date.getTime() - knownNewMoon.getTime()) / (1000 * 60 * 60 * 24);
  
  // Calculate phase (0-1, where 0 is new moon)
  const phase = (elapsed % synodicMonth) / synodicMonth;
  
  // Determine phase name and emoji (equal 12.5% duration for each phase)
  let name: MoonPhase;
  let emoji: string;
  
  if (phase < 0.0625 || phase >= 0.9375) {
    // New Moon (12.5% of cycle, centered on new moon)
    name = "New Moon";
    emoji = "🌑";
  } else if (phase < 0.1875) {
    // Waxing Crescent
    name = "Waxing Crescent";
    emoji = "🌒";
  } else if (phase < 0.3125) {
    // First Quarter
    name = "First Quarter";
    emoji = "🌓";
  } else if (phase < 0.4375) {
    // Waxing Gibbous
    name = "Waxing Gibbous";
    emoji = "🌔";
  } else if (phase < 0.5625) {
    // Full Moon
    name = "Full Moon";
    emoji = "🌕";
  } else if (phase < 0.6875) {
    // Waning Gibbous
    name = "Waning Gibbous";
    emoji = "🌖";
  } else if (phase < 0.8125) {
    // Last Quarter
    name = "Last Quarter";
    emoji = "🌗";
  } else {
    // Waning Crescent
    name = "Waning Crescent";
    emoji = "🌘";
  }
  
  return { name, emoji, phase };
}
