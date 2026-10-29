import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, realpath } from "node:fs/promises";
import { resolve, join, relative, dirname, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { MAX_DOCUMENT_BYTES } from "./document.ts";

export type ArtifactStatus = "draft" | "in_review" | "changes_requested" | "approved" | "abandoned";
export type ArtifactProgress = "discussing" | "reviewing" | "implementing" | "done";
export interface ArtifactRecord { id: string; path: string; createdAt: string; status: ArtifactStatus; revision?: string; progress?: ArtifactProgress; }
export const progressOf = (record: ArtifactRecord): ArtifactProgress => record.progress ?? (record.status === "in_review" ? "reviewing" : "discussing");
export interface Artifact { record: ArtifactRecord; content: string; revision: string; }
export interface Review {
  artifactId: string; targetPath: string; revision: string;
  decision: "approved" | "rejected"; overallComment?: string;
  lineComments: Array<{ line: number; comment: string; createdAt: string }>; reviewedAt: string;
}
export const revisionOf = (content: string): string => createHash("sha256").update(content).digest("hex");
const validId = (id: string) => /^art_[a-zA-Z0-9_-]+$/.test(id);
const validate = (content: string) => {
  if (content.includes("\0") || Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) throw new Error("Artifact must be text of at most 1 MiB.");
};
async function atomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, content, { flag: "wx", mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

/** Additive legacy migration. Immutable content-addressed snapshots never authorize execution. */
export class ArtifactStore {
  readonly root: string;
  readonly indexPath: string;
  constructor(readonly cwd: string) { this.root = resolve(cwd, ".pi/artifacts"); this.indexPath = join(this.root, "index.json"); }
  private async index(): Promise<{ artifacts: ArtifactRecord[] }> {
    let raw: string;
    try { raw = await readFile(this.indexPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { artifacts: [] }; throw error; }
    const data = JSON.parse(raw);
    if (!Array.isArray(data.artifacts) || data.artifacts.some((a: ArtifactRecord) => !a || !validId(a.id) || typeof a.path !== "string")) throw new Error("Invalid artifact index. Original data retained.");
    return data;
  }
  private async path(record: ArtifactRecord) {
    const target = resolve(this.cwd, record.path);
    if (!target.startsWith(this.root + sep) || !target.endsWith(".md")) throw new Error("Artifact path escapes its store.");
    // Do not allow a legacy index or a replacement symlink to address external files.
    const canonical = await realpath(target);
    const canonicalRoot = await realpath(this.root);
    if (!canonical.startsWith(canonicalRoot + sep)) throw new Error("Artifact symlink escapes its store.");
    return canonical;
  }
  private async snapshot(id: string, content: string): Promise<string> {
    validate(content);
    const revision = revisionOf(content), path = join(this.root, "revisions", id, `${revision}.md`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(path, "utf8") !== content) throw new Error("Corrupt immutable artifact revision.");
    }
    return revision;
  }
  private async current(index: { artifacts: ArtifactRecord[] }, id: string): Promise<Artifact> {
    const record = index.artifacts.find(a => a.id === id);
    if (!record) throw new Error(`Artifact not found: ${id}`);
    const content = await readFile(await this.path(record), "utf8");
    const revision = await this.snapshot(id, content);
    if (record.revision !== revision) {
      // Never trust a legacy review's mtime or approval after disk content changes.
      record.revision = revision;
      if (record.status !== "abandoned") {
        record.status = "draft";
        if (progressOf(record) !== "done") record.progress = "discussing";
      }
      await atomic(this.indexPath, JSON.stringify(index, null, 2));
    }
    return { record: { ...record }, content, revision };
  }
  async list(): Promise<ArtifactRecord[]> { return withFileMutationQueue(this.indexPath, async () => (await this.index()).artifacts.map(a => ({ ...a, progress: progressOf(a) }))); }
  async setProgress(id: string, progress: ArtifactProgress, expectedRevision?: string): Promise<void> {
    await withFileMutationQueue(this.indexPath, async () => {
      const index = await this.index(), artifact = await this.current(index, id);
      if (artifact.record.status === "abandoned") throw new Error("Artifact is abandoned.");
      if (expectedRevision && artifact.revision !== expectedRevision) throw new Error("Stale artifact revision. Read the current artifact before updating.");
      index.artifacts.find(a => a.id === id)!.progress = progress;
      await atomic(this.indexPath, JSON.stringify(index, null, 2));
    });
  }
  async filePath(id: string): Promise<string> {
    const record = (await this.list()).find(a => a.id === id && a.status !== "abandoned");
    if (!record) throw new Error("Artifact not found or removed.");
    return this.path(record);
  }
  async read(id: string): Promise<Artifact> { return withFileMutationQueue(this.indexPath, async () => this.current(await this.index(), id)); }
  async resolve(target: string): Promise<Artifact> {
    const records = await this.list();
    const record = records.find(a => a.status !== "abandoned" && (a.id === target || resolve(this.cwd, a.path) === resolve(this.cwd, target)));
    if (!record) throw new Error(`No artifact found for: ${target}`);
    return this.read(record.id);
  }
  async revision(id: string, revision: string): Promise<string> {
    if (!validId(id) || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid revision reference.");
    const content = await readFile(join(this.root, "revisions", id, `${revision}.md`), "utf8");
    if (revisionOf(content) !== revision) throw new Error("Corrupt immutable artifact revision.");
    return content;
  }
  async create(content: string, _title?: string): Promise<Artifact> {
    validate(content);
    return withFileMutationQueue(this.indexPath, async () => {
      const index = await this.index(), createdAt = new Date().toISOString(), id = `art_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const file = join(this.root, `${createdAt.slice(0, 10)}-${id}.md`);
      const revision = await this.snapshot(id, content);
      await writeFile(file, content, { flag: "wx", mode: 0o600 });
      const record: ArtifactRecord = { id, path: relative(this.cwd, file), createdAt, status: "draft", revision, progress: "discussing" };
      index.artifacts.push(record); await atomic(this.indexPath, JSON.stringify(index, null, 2));
      return { record, content, revision };
    });
  }
  async update(id: string, transform: (content: string) => string, expectedRevision?: string): Promise<Artifact> {
    return withFileMutationQueue(this.indexPath, async () => {
      const index = await this.index(), previous = await this.current(index, id);
      if (previous.record.status === "abandoned") throw new Error("Artifact is abandoned.");
      if (expectedRevision && previous.revision !== expectedRevision) throw new Error("Stale artifact revision. Read the current artifact before updating.");
      const content = transform(previous.content); validate(content);
      const revision = await this.snapshot(id, content), path = await this.path(previous.record);
      if (await readFile(path, "utf8") !== previous.content) throw new Error("Artifact changed during update. Retry after reading.");
      await atomic(path, content);
      const record = index.artifacts.find(a => a.id === id)!;
      record.revision = revision; record.status = "draft";
      if (content !== previous.content && progressOf(record) !== "done") record.progress = "discussing";
      await atomic(this.indexPath, JSON.stringify(index, null, 2));
      return { record: { ...record }, content, revision };
    });
  }
  async readReview(id: string, revision: string): Promise<Review | undefined> {
    if (!validId(id) || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid review reference.");
    for (const name of [`${id}.${revision}.review.json`, `${id}.review.json`]) {
      try {
        const data = JSON.parse(await readFile(join(this.root, "reviews", name), "utf8"));
        if (data.artifactId === id && data.revision === revision && Array.isArray(data.lineComments)) return data;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  async review(id: string, revision: string, decision: Review["decision"], overallComment = "", comments: Array<{ line: number; comment: string }> = []): Promise<Review> {
    return withFileMutationQueue(this.indexPath, async () => {
      const index = await this.index(), artifact = await this.current(index, id);
      if (artifact.revision !== revision) throw new Error("Artifact changed during review. Review the current revision again.");
      if (artifact.record.status === "abandoned") throw new Error("Artifact is abandoned.");
      const review: Review = { artifactId: id, targetPath: artifact.record.path, revision, decision, overallComment,
        lineComments: comments.map(c => ({ ...c, createdAt: new Date().toISOString() })), reviewedAt: new Date().toISOString() };
      await atomic(join(this.root, "reviews", `${id}.${revision}.review.json`), JSON.stringify(review, null, 2));
      await atomic(join(this.root, "reviews", `${id}.review.json`), JSON.stringify(review, null, 2));
      index.artifacts.find(a => a.id === id)!.status = decision === "approved" ? "approved" : "changes_requested";
      await atomic(this.indexPath, JSON.stringify(index, null, 2));
      return review;
    });
  }
  async abandon(id: string): Promise<void> {
    await withFileMutationQueue(this.indexPath, async () => {
      const index = await this.index(), record = index.artifacts.find(a => a.id === id);
      if (!record) throw new Error("Artifact not found.");
      record.status = "abandoned"; await atomic(this.indexPath, JSON.stringify(index, null, 2));
    });
  }
}

/** All replacements match the original document, uniquely and without overlap. */
export function exactEdits(original: string, edits: Array<{ oldText: string; newText: string }>): string {
  if (!edits.length) throw new Error("At least one edit is required.");
  const ranges = edits.map(({ oldText, newText }) => {
    if (!oldText) throw new Error("oldText must not be empty.");
    const start = original.indexOf(oldText);
    if (start < 0) throw new Error("oldText not found in artifact.");
    if (original.indexOf(oldText, start + 1) >= 0) throw new Error("oldText must match exactly one location in the original artifact content.");
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i - 1].end > ranges[i].start) throw new Error("edits overlap in original artifact content.");
  let text = original;
  for (const r of ranges.reverse()) text = text.slice(0, r.start) + r.newText + text.slice(r.end);
  return text;
}
