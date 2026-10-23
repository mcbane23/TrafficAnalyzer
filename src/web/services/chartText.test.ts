import { listOf, peakOf } from './chartText';

describe('chart text', () => {
  it('finds the peak, skipping gaps', () => {
    expect(peakOf(['07', '08', '09'], [3, null, 9])).toEqual({ label: '09', value: 9 });
    expect(peakOf(['07'], [null])).toBeNull();
  });

  it('lists the first entries and counts the rest', () => {
    const entries = [1, 2, 3].map((n) => ({ name: `K${n}`, value: n * 10 }));
    expect(listOf(entries, 2)).toBe('K1: 10, K2: 20, … (+1)');
    expect(listOf(entries)).toBe('K1: 10, K2: 20, K3: 30');
  });
});
