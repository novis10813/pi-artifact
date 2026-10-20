import { randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { DocumentBuffer } from "./buffer.ts";

export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export class ConflictError extends Error {}
type Queue = <T>(path: string, fn: () => Promise<T>) => Promise<T>;
const normalize = (s: string) => s.replace(/\r\n?/g, "\n");

/** Exact disk baseline prevents an ordinary external edit from being overwritten. */
export class DocumentSession {
  readonly buffer: DocumentBuffer;
  conflict = false;
  private constructor(readonly path: string, private baseline: string) {
    this.buffer = new DocumentBuffer(normalize(baseline));
  }
  static async open(path: string): Promise<DocumentSession> {
    const canonical = await realpath(path);
    if (!/\.md$/i.test(canonical)) throw new Error("Open an existing .md file.");
    const info = await stat(canonical);
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw new Error("Markdown must be a regular file of at most 1 MiB.");
    const text = await readFile(canonical, "utf8");
    if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES || text.includes("\0")) throw new Error("Invalid or oversized Markdown file.");
    return new DocumentSession(canonical, text);
  }
  get dirty(): boolean { return this.buffer.text !== normalize(this.baseline); }
  async refresh(): Promise<void> {
    const info = await stat(this.path);
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw new Error("File is no longer a supported Markdown document.");
    const disk = await readFile(this.path, "utf8");
    if (disk === this.baseline) { this.conflict = false; return; }
    if (this.dirty) { this.conflict = true; return; }
    if (disk.includes("\0") || Buffer.byteLength(disk) > MAX_DOCUMENT_BYTES) throw new Error("Invalid or oversized Markdown file.");
    this.baseline = disk; this.buffer.replace(normalize(disk)); this.conflict = false;
  }
  async save(queue: Queue): Promise<void> {
    await queue(this.path, async () => {
      let disk: string;
      try { disk = await readFile(this.path, "utf8"); }
      catch { this.conflict = true; throw new ConflictError("File missing or unreadable. Draft kept in memory."); }
      if (disk !== this.baseline) { this.conflict = true; throw new ConflictError("File changed on disk. Draft kept. Save a copy or reopen after discarding explicitly."); }
      const text = this.buffer.text;
      if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds 1 MiB.");
      const info = await stat(this.path);
      const temp = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
      const output = this.baseline.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
      try {
        await writeFile(temp, output, { flag: "wx", mode: info.mode & 0o777 });
        if (await readFile(this.path, "utf8") !== this.baseline) { this.conflict = true; throw new ConflictError("File changed during save. Draft kept."); }
        await rename(temp, this.path);
        this.baseline = output; this.conflict = false;
      } finally { await unlink(temp).catch(() => {}); }
    });
  }
  async saveCopy(path: string): Promise<void> {
    await writeFile(path, this.buffer.text, { flag: "wx", mode: 0o600 });
  }
}
