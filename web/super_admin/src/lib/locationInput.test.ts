import { describe, expect, it } from 'vitest';
import { parseLocationInput } from './campus';

const LAT = 23.0815;
const LNG = 76.843056;

describe('parseLocationInput: every way an admin might paste a point (all must give the same pin)', () => {
  const same: [string, string][] = [
    ['owner example', `23°04'53.4"N 76°50'35.0"E`],
    ['no space between the two', `23°04'53.4"N76°50'35.0"E`],
    ['comma between', `23°04'53.4"N, 76°50'35.0"E`],
    ['lower case letters', `23°04'53.4"n 76°50'35.0"e`],
    ['no seconds mark', `23°04'53.4N 76°50'35.0E`],
    ['two apostrophes for seconds', `23°04'53.4''N 76°50'35.0''E`],
    ['prime symbols', `23°04′53.4″N 76°50′35.0″E`],
    ['curly quotes', `23°04’53.4”N 76°50’35.0”E`],
    ['ordinal sign instead of degree', `23º04'53.4"N 76º50'35.0"E`],
    ['ring above instead of degree', `23˚04'53.4"N 76˚50'35.0"E`],
    ['decimal comma in seconds', `23°04'53,4"N 76°50'35,0"E`],
    ['extra spaces', `23° 04' 53.4" N   76° 50' 35.0" E`],
    ['newline between', `23°04'53.4"N\n76°50'35.0"E`],
    ['non-breaking space', `23°04'53.4"N 76°50'35.0"E`],
    ['leading and trailing blanks', `\t  23°04'53.4"N 76°50'35.0"E  \n`],
    ['east/west first', `76°50'35.0"E, 23°04'53.4"N`],
    ['no letters at all', `23°04'53.4" 76°50'35.0"`],
    ['spaces only with letters', `23 04 53.4 N 76 50 35.0 E`],
    ['letters in front', `N 23°04'53.4" E 76°50'35.0"`],
  ];
  it.each(same)('%s', (_n, text) => {
    const r = parseLocationInput(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lat).toBeCloseTo(LAT, 5);
      expect(r.lng).toBeCloseTo(LNG, 5);
    }
  });

  it('degrees and decimal minutes, decimal degrees with letters, prefix letters', () => {
    expect(parseLocationInput(`23°04.89'N 76°50.583'E`)).toEqual({ ok: true, lat: 23.0815, lng: 76.84305 });
    for (const t of [`23.0815°N 76.8431°E`, `23.0815 N, 76.8431 E`, `N 23.0815 E 76.8431`, `23.0815°, 76.8431°`, `23.0815, 76.8431`, `23.0815 76.8431`, `(23.0815, 76.8431)`]) {
      expect(parseLocationInput(t)).toEqual({ ok: true, lat: 23.0815, lng: 76.8431 });
    }
  });

  it('very long numbers are rounded to 6 decimals (no floating point noise)', () => {
    expect(parseLocationInput(`23.081500000000001, 76.843055555555559`)).toEqual({ ok: true, lat: 23.0815, lng: 76.843056 });
    const r = parseLocationInput(`23°04'53.123456789"N 76°50'35.987654321"E`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.lat).split('.')[1].length).toBeLessThanOrEqual(6);
  });

  it('map links still work', () => {
    expect(parseLocationInput('https://www.google.com/maps/place/x/@23.0815,76.8431,17z')).toEqual({ ok: true, lat: 23.0815, lng: 76.8431 });
    expect(parseLocationInput('https://www.google.com/maps?q=23.0815,76.8431')).toEqual({ ok: true, lat: 23.0815, lng: 76.8431 });
  });

  const refused: [string, string, RegExp][] = [
    ['minutes of 60 or more', `23°61'53.4"N 76°50'35.0"E`, /Minutes must be below 60/],
    ['seconds of 60 or more', `23°04'75.4"N 76°50'35.0"E`, /Seconds must be below 60/],
    ['latitude above 90', `95°04'53.4"N 76°50'35.0"E`, /out of range/],
    ['two latitudes', `23°04'53.4"N 23°04'53.4"N`, /one north\/south value and one east\/west/],
    ['only one number', `23°04'53.4"N`, /Could not read/],
    ['plain text', `abc`, /Could not read/],
    ['a plus code', `7JF3+2X Bhopal`, /Could not read/],
    ['southern/western hemisphere (not India)', `23°04'53.4"S 76°50'35.0"W`, /3 km/],
    ['another city', `28°36'50.0"N 77°12'32.0"E`, /3 km/],
    ['negative degrees', `-23°04'53.4" 76°50'35.0"`, /3 km/],
    ['swapped decimals, with a hint', `76.8431, 23.0815`, /look swapped.*23\.08150, 76\.84310/],
    ['empty', ``, /Paste the coordinates/],
  ];
  it.each(refused)('refuses %s with a clear message', (_n, text, msg) => {
    const r = parseLocationInput(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(msg);
  });
});
