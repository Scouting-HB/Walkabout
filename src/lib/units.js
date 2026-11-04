// Display units: US customary first, metric in parentheses. Internally everything is metres.

const n = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const miles = (m) => `${n(m / 1609.344, m < 16093 ? 2 : 1)} mi`;
export const kms = (m) => `${n(m / 1000, m < 10000 ? 2 : 1)} km`;
export const feet = (m) => `${n(m * 3.28084)} ft`;
export const meters = (m) => `${n(m)} m`;

/** "8.14 mi (13.1 km)" */
export const dist = (m) => `${miles(m)} (${kms(m)})`;
/** "1,919 ft (585 m)": street lengths, climb */
export const short = (m) => `${feet(m)} (${meters(m)})`;
/** "0.52 mi² (1.34 km²)" */
export const area = (m2) => `${n(m2 / 2589988.11, 2)} mi² (${n(m2 / 1e6, 2)} km²)`;

/** Rough time: door-to-door at 2.5 km/h, walking between at 4.5 km/h, +1 min per 10 m climbed. */
export const minutes = (w) => Math.round((w.work / 2500 + (w.length - w.work) / 4500) * 60 + w.up / 10);
export const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);
