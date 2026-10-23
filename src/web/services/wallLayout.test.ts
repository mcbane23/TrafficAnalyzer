import { wallCameras } from './wallLayout';

const cams = [
  { id: 'a', status: 'active' },
  { id: 'b', status: 'inactive' },
  { id: 'c', status: 'active' },
  { id: 'd', status: 'active' },
  { id: 'e', status: 'active' },
  { id: 'f', status: 'active' },
];

describe('wallCameras', () => {
  it('starts with favorites, then the other working cameras', () => {
    expect(wallCameras(null, cams, new Set(['e']))).toEqual(['e', 'a', 'c', 'd']);
  });

  it('keeps a saved choice, emptying slots whose camera is gone', () => {
    expect(wallCameras(['d', 'gone', null], cams, new Set())).toEqual(['d', null, null, null]);
  });

  it('pads when there are fewer working cameras than slots', () => {
    expect(wallCameras(null, cams.slice(0, 3), new Set())).toEqual(['a', 'c', null, null]);
  });
});
