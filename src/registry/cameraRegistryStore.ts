import { readFile, writeFile } from 'node:fs/promises';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { CameraEntry } from '../types/camera';

/**
 * CameraRegistryStore loads and saves the camera registry JSON file,
 * validating its contents against the registry's JSON Schema on every
 * read and write so the file on disk can never silently drift from its
 * documented contract.
 *
 * This module intentionally knows nothing about *how* a camera is
 * validated (that's `CameraValidator`'s job) - it only knows how to get
 * a well-formed list of `CameraEntry` objects in and out of a file.
 */
export class CameraRegistryStore {
  private readonly registryPath: string;
  private readonly schemaPath: string;
  private readonly ajv: Ajv2020;
  private compiledValidator?: ValidateFunction;

  constructor(registryPath: string, schemaPath: string) {
    this.registryPath = registryPath;
    this.schemaPath = schemaPath;
    this.ajv = new Ajv2020({ allErrors: true });
    addFormats(this.ajv);
  }

  async load(): Promise<CameraEntry[]> {
    const raw = await readFile(this.registryPath, 'utf-8');
    const data = JSON.parse(raw);
    await this.assertValid(data);
    return data as CameraEntry[];
  }

  async save(entries: CameraEntry[]): Promise<void> {
    await this.assertValid(entries);
    await writeFile(this.registryPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
  }

  private async assertValid(data: unknown): Promise<void> {
    const validate = await this.getValidator();
    const valid = validate(data);
    if (!valid) {
      const details = this.ajv.errorsText(validate.errors, { separator: '\n  - ' });
      throw new Error(`Camera registry (${this.registryPath}) failed schema validation:\n  - ${details}`);
    }
  }

  private async getValidator(): Promise<ValidateFunction> {
    if (!this.compiledValidator) {
      const schemaRaw = await readFile(this.schemaPath, 'utf-8');
      const schema = JSON.parse(schemaRaw);
      this.compiledValidator = this.ajv.compile(schema);
    }
    return this.compiledValidator;
  }
}
