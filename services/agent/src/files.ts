import { constants } from 'node:fs';
import { open, realpath, stat, mkdir, unlink } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { type AgentConfig, MAX_INPUT_BYTES } from './config.ts';

export const fileNameSchema = z.string().trim().min(1).max(200).refine(value => !/[\\/\x00-\x1f]/.test(value) && !['.', '..'].includes(value), 'Use a filename without directories or control characters.');
export const importSchema = z.object({
  localPath: z.string().min(1).max(4096).optional().describe('File inside an OIT_INPUT_ROOTS directory; relative paths resolve against the agent working directory.'),
  fileName: fileNameSchema.optional().describe('Required for base64/text imports, including an extension such as .pdf or .md.'),
  base64: z.string().min(1).max(Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 4096).optional().describe('Base64-encoded file bytes, at most 25 MB decoded.'),
  text: z.string().min(1).max(MAX_INPUT_BYTES).optional().describe('UTF-8 document text, at most 25 MB encoded.'),
}).strict().superRefine((input, context) => {
  const count = [input.localPath, input.base64, input.text].filter(value => value !== undefined).length;
  if (count !== 1 || (input.localPath !== undefined ? input.fileName !== undefined : input.fileName === undefined)) {
    context.addIssue({ code: 'custom', message: 'Provide exactly localPath OR fileName+base64 OR fileName+text.' });
  }
});
export type ImportInput = z.infer<typeof importSchema>;

function inside(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

export async function readInput(config: AgentConfig, input: ImportInput, signal: AbortSignal): Promise<{ fileName: string; bytes: Buffer }> {
  input = importSchema.parse(input);
  signal.throwIfAborted();
  if (input.localPath !== undefined) {
    const path = await realpath(resolve(config.cwd, input.localPath));
    const roots = await Promise.all(config.inputRoots.map(async root => {
      try { return await realpath(root); } catch { return undefined; }
    }));
    if (!roots.some(root => root && inside(path, root))) throw new Error('File is outside OIT_INPUT_ROOTS. Add its directory to the agent configuration, or use an explicit text/base64 attachment.');
    const before = await stat(path);
    if (!before.isFile()) throw new Error('Import a regular file, not a directory or device.');
    if (before.size > MAX_INPUT_BYTES) throw new Error('Document exceeds the 25 MB input limit.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const currentPath = await realpath(path);
      const current = await stat(currentPath);
      if (!roots.some(root => root && inside(currentPath, root)) || current.dev !== opened.dev || current.ino !== opened.ino || !opened.isFile()) throw new Error('Input file changed during validation; try importing it again.');
      if (opened.size > MAX_INPUT_BYTES) throw new Error('Document exceeds the 25 MB input limit.');
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_INPUT_BYTES - total + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_INPUT_BYTES) throw new Error('Document exceeds the 25 MB input limit.');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return { fileName: fileNameSchema.parse(basename(path)), bytes: Buffer.concat(chunks, total) };
    } finally { await handle.close(); }
  }
  if (input.text !== undefined) {
    if (Buffer.byteLength(input.text, 'utf8') > MAX_INPUT_BYTES) throw new Error('Document exceeds the 25 MB UTF-8 input limit.');
    return { fileName: input.fileName!, bytes: Buffer.from(input.text, 'utf8') };
  }
  const encoded = input.base64!.replace(/\s/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Attachment is not valid padded base64.');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (encoded.length / 4 * 3 - padding > MAX_INPUT_BYTES) throw new Error('Document exceeds the 25 MB input limit.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Attachment has invalid base64 padding or trailing bits.');
  return { fileName: input.fileName!, bytes };
}

export async function saveExport(config: AgentConfig, inputName: string, extension: 'html' | 'md', content: Buffer, signal: AbortSignal): Promise<{ path: string; fileName: string }> {
  signal.throwIfAborted();
  await mkdir(config.outputDirectory, { recursive: true });
  const directory = await realpath(config.outputDirectory);
  const stem = basename(inputName).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '').slice(0, 100) || 'document';
  const fileName = `${stem}-${randomUUID()}.${extension}`;
  const path = join(directory, fileName);
  const handle = await open(path, 'wx', 0o600);
  try { signal.throwIfAborted(); await handle.writeFile(content, { signal }); }
  catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
  finally { await handle.close(); }
  return { path, fileName };
}
