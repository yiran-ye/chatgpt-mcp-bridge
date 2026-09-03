import { createRequire } from 'node:module';
import { z } from 'zod/v4';

const packageSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u) });
const require = createRequire(import.meta.url);
export const PACKAGE_VERSION = packageSchema.parse(require('../../package.json') as unknown).version;
