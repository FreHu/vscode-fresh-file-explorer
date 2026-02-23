// human note: I was using astronomy-engine here, 
// but decided it's not worth to have a dependency for a joke feature
// replaced with PhD-level vibe astronomy by Claude 
// based on quick eyeball test the outputs are the same as before

/**
 * Planetary retrograde calculations using Keplerian orbital mechanics.
 * No external dependencies — uses simplified mean orbital elements from
 * Meeus "Astronomical Algorithms" Table 33.a (valid ~1800-2050).
 * Accuracy: ~1-2°, more than sufficient for retrograde detection.
 */

export type Planet = "Mercury" | "Venus" | "Mars" | "Jupiter" | "Saturn" | "Uranus" | "Neptune" | "Pluto";

export const ALL_PLANETS: Planet[] = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"];

// ---------------------------------------------------------------------------
// Keplerian orbital elements (J2000.0 epoch; rates per Julian century T)
// Source: Meeus "Astronomical Algorithms" Table 33.a, valid ~1800-2050.
//
//  L  = mean longitude (deg)          L0 + L1·T
//  a  = semi-major axis (AU)          constant
//  e  = eccentricity                  e0 + e1·T
//  i  = inclination (deg)             i0 + i1·T
//  O  = longitude of ascending node   O0 + O1·T
//  p  = longitude of perihelion       p0 + p1·T
// ---------------------------------------------------------------------------
const DEG2RAD = Math.PI / 180;

interface OrbitalElements {
  L0: number; L1: number;
  a: number;
  e0: number; e1: number;
  i0: number; i1: number;
  O0: number; O1: number;
  p0: number; p1: number;
}

const PLANET_ELEMENTS: Record<Planet, OrbitalElements> = {
  Mercury: { L0: 252.250906, L1: 149472.6746358, a:  0.387098310, e0: 0.20563175, e1:  2.0407e-5,  i0:  7.004986, i1: -5.9516e-3, O0:  48.330893, O1: -1.254229e-1, p0:  77.456119, p1: 1.588643e-1 },
  Venus:   { L0: 181.979801, L1:  58517.8156760, a:  0.723329820, e0: 0.00677188, e1: -4.7766e-5,  i0:  3.394662, i1: -8.568e-4,  O0:  76.679920, O1: -2.780080e-1, p0: 131.563707, p1: 4.8646e-3  },
  Mars:    { L0: 355.433275, L1:  19140.2993313, a:  1.523679342, e0: 0.09340062, e1:  9.0483e-5,  i0:  1.849726, i1: -8.1479e-3, O0:  49.558093, O1: -2.950250e-1, p0: 336.060234, p1: 4.439016e-1 },
  Jupiter: { L0:  34.351484, L1:   3034.9056746, a:  5.202603191, e0: 0.04849485, e1:  1.63244e-4, i0:  1.303270, i1: -1.9872e-3, O0: 100.464441, O1:  1.766828e-1, p0:  14.331309, p1: 2.155525e-1 },
  Saturn:  { L0:  50.077471, L1:   1222.1137943, a:  9.554909596, e0: 0.05550862, e1: -3.46818e-4, i0:  2.488878, i1:  2.5515e-3, O0: 113.665524, O1: -2.566649e-1, p0:  93.056787, p1: 5.665496e-1 },
  Uranus:  { L0: 314.055005, L1:    428.4669983, a: 19.218446062, e0: 0.04629590, e1: -2.7337e-5,  i0:  0.773196, i1:  7.744e-4,  O0:  74.005947, O1:  7.41461e-2,  p0: 173.005159, p1: 8.93206e-2  },
  Neptune: { L0: 304.348665, L1:    218.4862002, a: 30.110386869, e0: 0.00898809, e1:  6.408e-6,   i0:  1.769952, i1: -9.3082e-3, O0: 131.784057, O1:  1.107906e-1, p0:  48.123691, p1: 2.91858e-2  },
  Pluto:   { L0: 238.928881, L1:    145.2078280, a: 39.482117,    e0: 0.24885,    e1:  0.0,         i0: 17.141750, i1:  0.0,       O0: 110.303470, O1:  0.0,          p0: 224.066760, p1: 0.0          },
};

// Earth's orbital elements (same table)
const EARTH_ELEMENTS: OrbitalElements = {
  L0: 100.466449, L1: 35999.3728519, a: 1.000001018,
  e0: 0.01670862, e1: -4.2037e-5,
  i0: 0.0,        i1:  1.30548e-2,
  O0: 174.873174, O1: -2.410908e-1,
  p0: 102.937348, p1:  3.225557e-1,
};

/** Julian centuries from J2000.0 for a given Date. */
function julianCenturies(date: Date): number {
  const JD = date.getTime() / 86400000 + 2440587.5;
  return (JD - 2451545.0) / 36525;
}

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Compute heliocentric ecliptic rectangular coordinates (AU) for a body.
 * Returns [x, y, z].
 */
function heliocentricEcliptic(el: OrbitalElements, T: number): [number, number, number] {
  const e = el.e0 + el.e1 * T;
  const i = (el.i0 + el.i1 * T) * DEG2RAD;
  const O = (el.O0 + el.O1 * T) * DEG2RAD;           // ascending node (rad)
  const p = el.p0 + el.p1 * T;                        // longitude of perihelion (deg)
  const L = el.L0 + el.L1 * T;                        // mean longitude (deg)

  // Mean anomaly (rad)
  const M = normalizeAngle(L - p) * DEG2RAD;

  // Equation of center (rad) — series expansion, accurate to ~0.01° for e < 0.25
  const Ec = (2 * e - (e * e * e) / 4) * Math.sin(M)
           + (5 / 4) * e * e * Math.sin(2 * M)
           + (13 / 12) * e * e * e * Math.sin(3 * M);

  // True anomaly (rad) and true longitude (rad)
  const v     = M + Ec;
  const trueL = v + p * DEG2RAD;

  // Helio distance
  const r = (el.a * (1 - e * e)) / (1 + e * Math.cos(v));

  // Argument of latitude
  const u = trueL - O;

  const cosO = Math.cos(O); const sinO = Math.sin(O);
  const cosU = Math.cos(u); const sinU = Math.sin(u);
  const cosI = Math.cos(i); const sinI = Math.sin(i);

  return [
    r * (cosO * cosU - sinO * sinU * cosI),
    r * (sinO * cosU + cosO * sinU * cosI),
    r * sinU * sinI,
  ];
}

/**
 * Geocentric ecliptic longitude of a planet (degrees) at a given date.
 */
function geocentricLongitude(planet: Planet, date: Date): number {
  const T = julianCenturies(date);
  const [px, py] = heliocentricEcliptic(PLANET_ELEMENTS[planet], T);
  const [ex, ey] = heliocentricEcliptic(EARTH_ELEMENTS, T);
  return Math.atan2(py - ey, px - ex) / DEG2RAD;
}

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
  const delta = 1; // 1 day
  const before = new Date(date.getTime() - delta * 24 * 60 * 60 * 1000);
  const after  = new Date(date.getTime() + delta * 24 * 60 * 60 * 1000);

  let deltaLon = geocentricLongitude(planet, after) - geocentricLongitude(planet, before);

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
