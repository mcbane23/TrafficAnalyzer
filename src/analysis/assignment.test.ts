import { solveAssignment } from './assignment';

describe('solveAssignment', () => {
  it('returns an empty assignment for no rows', () => {
    expect(solveAssignment([])).toEqual([]);
  });

  it('leaves every row unassigned when there are no columns', () => {
    expect(solveAssignment([[], []])).toEqual([-1, -1]);
  });

  it('finds the globally cheapest pairing where greedy would not', () => {
    // Greedy takes (0,0)=1 first, forcing (1,1)=10: total 11.
    // Optimal is (0,1)=2 + (1,0)=2: total 4.
    const cost = [
      [1, 2],
      [2, 10],
    ];
    expect(solveAssignment(cost)).toEqual([1, 0]);
  });

  it('never uses a disallowed (Infinity) pairing', () => {
    const cost = [
      [Infinity, Infinity],
      [0.5, Infinity],
    ];
    expect(solveAssignment(cost)).toEqual([-1, 0]);
  });

  it('handles more rows than columns, leaving the costliest unassigned', () => {
    const cost = [[0.9], [0.1], [0.5]];
    expect(solveAssignment(cost)).toEqual([-1, 0, -1]);
  });

  it('handles more columns than rows', () => {
    const cost = [[0.9, 0.2, 0.5]];
    expect(solveAssignment(cost)).toEqual([1]);
  });
});
