import { z } from 'zod/v4';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_TIMEOUT_MS = 25_000;
export const attachmentDownloadUrlSchema = z.string().min(1).max(8192);

// All four properties must be declared; only download_url and file_id may be required.
export const attachmentInputSchema = z.object({
  file: z.object({
    download_url: attachmentDownloadUrlSchema,
    file_id: z.string().min(1).max(1024),
    mime_type: z.string().max(255).optional(),
    file_name: z.string().max(4096).optional(),
  }).strict(),
  path: z.string().min(1).max(4096).describe('完整的工作区相对文件路径，例如 assets/image.png'),
}).strict();

export const attachmentOutputSchema = z.object({
  data: z.object({
    path: z.string().min(1),
    bytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict();

export type AttachmentInput = z.infer<typeof attachmentInputSchema>;
export type AttachmentResult = z.infer<typeof attachmentOutputSchema>['data'];
