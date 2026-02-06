/**
 * Planetary retrograde calculations using astronomy-engine
 */

import * as Astronomy from "astronomy-engine";

export type Planet = "Mercury" | "Venus" | "Mars" | "Jupiter" | "Saturn" | "Uranus" | "Neptune" | "Pluto";

export const ALL_PLANETS: Planet[] = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"];

// Cache for retrograde calculations (date string -> planet -> isRetrograde)
const retrogradeCache = new Map<string, Map<Planet, boolean>>();

/**
 * Get cache key for a date (YYYY-MM-DD format, ignoring time)
 */
function getDateCacheKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

export interface RetrogradeInfo {
  planets: Planet[];
  displayName: string;
}

/**
 * Check if a planet is in retrograde on a given date (with caching).
 * A planet is retrograde when its ecliptic longitude is decreasing (negative velocity)
 * from Earth's perspective (geocentric).
 */
function isPlanetRetrograde(planet: Planet, date: Date): boolean {
  // Check cache first
  const cacheKey = getDateCacheKey(date);
  
  if (!retrogradeCache.has(cacheKey)) {
    retrogradeCache.set(cacheKey, new Map());
  }
  
  const dateCache = retrogradeCache.get(cacheKey)!;
  
  if (dateCache.has(planet)) {
    return dateCache.get(planet)!;
  }

  // Calculate if not cached
  // Convert planet name to astronomy-engine Body enum
  const bodyMap: Record<Planet, Astronomy.Body> = {
    Mercury: Astronomy.Body.Mercury,
    Venus: Astronomy.Body.Venus,
    Mars: Astronomy.Body.Mars,
    Jupiter: Astronomy.Body.Jupiter,
    Saturn: Astronomy.Body.Saturn,
    Uranus: Astronomy.Body.Uranus,
    Neptune: Astronomy.Body.Neptune,
    Pluto: Astronomy.Body.Pluto,
  };

  const body = bodyMap[planet];

  // Calculate velocity by checking position slightly before and after
  const delta = 1; // 1 day
  const before = new Date(date.getTime() - delta * 24 * 60 * 60 * 1000);
  const after = new Date(date.getTime() + delta * 24 * 60 * 60 * 1000);
  
  // Get GEOCENTRIC (not heliocentric) ecliptic coordinates
  // The 'true' parameter means equator of date (not J2000)
  const eclipBefore = Astronomy.Ecliptic(Astronomy.GeoVector(body, before, true));
  const eclipAfter = Astronomy.Ecliptic(Astronomy.GeoVector(body, after, true));
  
  // Calculate velocity (change in longitude)
  let deltaLon = eclipAfter.elon - eclipBefore.elon;
  
  // Handle wraparound at 360 degrees
  if (deltaLon > 180) {
    deltaLon -= 360;
  } else if (deltaLon < -180) {
    deltaLon += 360;
  }
  
  // Negative velocity = retrograde
  const isRetrograde = deltaLon < 0;
  
  // Cache the result
  dateCache.set(planet, isRetrograde);
  
  return isRetrograde;
}

/**
 * Get all planets that are in retrograde on a given date.
 */
export function getRetrogradePlanets(date: Date): Planet[] {
  const retrogradePlanets: Planet[] = [];

  for (const planet of ALL_PLANETS) {
    if (isPlanetRetrograde(planet, date)) {
      retrogradePlanets.push(planet);
    }
  }

  return retrogradePlanets;
}

/**
 * Get retrograde information for a given date.
 */
export function getRetrogradeInfo(date: Date): RetrogradeInfo {
  const planets = getRetrogradePlanets(date);

  if (planets.length === 0) {
    return {
      planets: [],
      displayName: "No Retrograde",
    };
  }

  // Create display name
  const displayName = planets.join(" + ");

  return {
    planets,
    displayName,
  };
}

/**
 * Create a unique key for a retrograde combination.
 */
export function getRetrogradeKey(planets: Planet[]): string {
  if (planets.length === 0) {
    return "none";
  }
  return planets.sort().join("+");
}

/**
 * Clear the retrograde cache (useful when switching time windows or refreshing).
 */
export function clearRetrogradeCache(): void {
  retrogradeCache.clear();
}
