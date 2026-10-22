import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedMissingFiles } from './seedRegistry';

describe('seedMissingFiles', () => {
  let root: string;
  let defaults: string;
  let target: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
    defaults = path.join(root, 'defaults');
    target = path.join(root, 'data', 'cameras');
    fs.mkdirSync(defaults);
    fs.writeFileSync(path.join(defaults, 'belgrade.json'), '{"default":true}');
    fs.writeFileSync(path.join(defaults, 'belgrade.schema.json'), '{}');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('fills an empty data folder with the default registry', () => {
    expect(seedMissingFiles(defaults, target).sort()).toEqual(['belgrade.json', 'belgrade.schema.json']);
    expect(fs.readFileSync(path.join(target, 'belgrade.json'), 'utf8')).toBe('{"default":true}');
  });

  it('never overwrites a registry that is already there', () => {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'belgrade.json'), '{"edited":true}');

    expect(seedMissingFiles(defaults, target)).toEqual(['belgrade.schema.json']);
    expect(fs.readFileSync(path.join(target, 'belgrade.json'), 'utf8')).toBe('{"edited":true}');
  });

  it('copies nothing without a defaults folder', () => {
    expect(seedMissingFiles(path.join(root, 'missing'), target)).toEqual([]);
  });
});
