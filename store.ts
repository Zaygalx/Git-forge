// The forge's engine: the in-memory store, git objects (SHA-1, trees, commits, tags),
// packfile read/write (plain + delta entries), pkt-line framing, and the graph
// operations the surfaces need (reachability, diff, merge-base).
//
// Everything is deterministic: no wall clock, no randomness. Server-created commits
// use one fixed timestamp so repeated runs produce identical objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The login the trial's bearer token names (wire.ts's scenario is one fixed seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** Fixed timestamp for every server-created commit (2026-11-17T00:00:00Z). */
export const FIXED_TS = 1763356800;
export const FIXED_ISO = '2026-11-17T00:00:00.000Z';
export const SERVER_VERSION = '1.0.0';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// Object parsing
// ---------------------------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space);
    if (nul === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger };
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------------------------

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a list of lines, where 'flush'/'delim' are control packets. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line truncated');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** A sideband packet: one pkt-line whose payload starts with the band byte (1, 2 or 3). */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Wrap bytes in band-1 sideband packets of at most `chunk` bytes each. */
export function sidebandWrap(data: Buffer, chunk = 32768): Buffer[] {
  const out: Buffer[] = [];
  if (data.length === 0) return out;
  for (let offset = 0; offset < data.length; offset += chunk) {
    out.push(sidebandPacket(1, data.subarray(offset, Math.min(data.length, offset + chunk))));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function encodePackEntryHeader(typeId: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  const firstByte = (typeId << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining === 0) {
    bytes.push(firstByte);
  } else {
    bytes.push(firstByte | 0x80);
    while (remaining > 0) {
      const byte = remaining & 0x7f;
      remaining >>>= 7;
      bytes.push(remaining === 0 ? byte : byte | 0x80);
    }
  }
  return Buffer.from(bytes);
}

/** Write a pack (version 2, plain entries, SHA-1 trailer). Entries are sorted by oid. */
export function writePack(objects: ReadonlyMap<string, GitObject> | readonly GitObject[]): Buffer {
  const entries: Array<{ oid: string; object: GitObject }> = [];
  if (Array.isArray(objects)) {
    for (const object of objects) entries.push({ oid: hashObject(object.type, object.data), object });
  } else {
    for (const [oid, object] of objects) entries.push({ oid, object });
  }
  entries.sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const { object } of entries) {
    parts.push(encodePackEntryHeader(PACK_TYPE_IDS[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readOfsVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = buffer[offset] & 0x7f;
  let pos = offset + 1;
  while (buffer[pos - 1] & 0x80) {
    value = ((value + 1) << 7) | (buffer[pos] & 0x7f);
    pos += 1;
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const srcSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Parse a packfile (plain, OFS_DELTA and REF_DELTA entries). Verifies the trailer. */
export function readPack(buffer: Buffer): Map<string, GitObject> {
  if (buffer.length < 32) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20);
  const actual = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  if (!actual.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; object: GitObject }>();
  const pending: Array<{ entryOffset: number; baseOffset: number; delta: Buffer }> = [];
  const pendingRef: Array<{ entryOffset: number; baseOid: string; delta: Buffer }> = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const typeId = (buffer[offset] >> 4) & 0x07;
    let size = buffer[offset] & 0x0f;
    let shift = 4;
    offset += 1;
    while (buffer[offset - 1] & 0x80) {
      size |= (buffer[offset] & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (typeId === 6) {
      const read = readOfsVarint(buffer, offset);
      baseOffset = entryOffset - read.value;
      offset = read.next;
    } else if (typeId === 7) {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // inflateSync stops at the end of the zlib stream and ignores what follows,
    // so inflating from `offset` yields exactly this entry's bytes. The stream's
    // consumed length is recovered by findDeflateEnd below.
    const inflated = inflateSync(buffer.subarray(offset));
    offset = findDeflateEnd(buffer, offset, size);
    if (typeId === 6) {
      pending.push({ entryOffset, baseOffset, delta: inflated });
    } else if (typeId === 7) {
      pendingRef.push({ entryOffset, baseOid, delta: inflated });
    } else {
      const type = PACK_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack entry type ${typeId}`);
      if (inflated.length !== size) throw new Error('pack entry size mismatch');
      const oid = hashObject(type, inflated);
      const object: GitObject = { type, data: Buffer.from(inflated) };
      objects.set(oid, object);
      byOffset.set(entryOffset, { oid, object });
    }
  }
  const resolve = (entryOffset: number, baseOffset: number, delta: Buffer): void => {
    const base = byOffset.get(baseOffset);
    if (base === undefined) throw new Error('delta base not in pack');
    const data = applyDelta(base.object.data, delta);
    const oid = hashObject(base.object.type, data);
    const object: GitObject = { type: base.object.type, data };
    objects.set(oid, object);
    byOffset.set(entryOffset, { oid, object });
  };
  // OFS deltas may chain; resolve in offset order (bases always precede their deltas).
  pending.sort((a, b) => a.entryOffset - b.entryOffset);
  for (const item of pending) resolve(item.entryOffset, item.baseOffset, item.delta);
  for (const item of pendingRef) {
    const base = objects.get(item.baseOid);
    if (base === undefined) throw new Error('ref-delta base not in pack');
    const data = applyDelta(base.data, item.delta);
    const oid = hashObject(base.type, data);
    const object: GitObject = { type: base.type, data };
    objects.set(oid, object);
    byOffset.set(item.entryOffset, { oid, object });
  }
  if (objects.size !== count) throw new Error('pack entry count mismatch');
  return objects;
}

/** Find where a zlib stream starting at `offset` ends, expecting `size` inflated bytes. */
function findDeflateEnd(buffer: Buffer, offset: number, size: number): number {
  // inflateSync stops at the stream end and ignores trailing bytes, so success is
  // monotonic in the slice end: every end before the true end throws (or yields a
  // short output), every end at or after it yields exactly `size` bytes. Find the
  // smallest end that succeeds.
  let low = offset;
  let high = buffer.length - 20;
  let answer = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const out = inflateSync(buffer.subarray(offset, mid));
      if (out.length === size) {
        answer = mid;
        high = mid - 1;
      } else if (out.length < size) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    } catch {
      low = mid + 1;
    }
  }
  if (answer === -1) throw new Error('cannot find deflate stream end');
  return answer;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  idNum: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  createdSeq: number;
}

export interface Pull {
  idNum: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Comment {
  idNum: number;
  gid: string;
  body: string;
}

export interface Repo {
  dbId: number;
  gid: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  nextIssue: number;
  labels: Map<string, Label>;
  pulls: Pull[];
  nextPull: number;
  comments: Map<number, Comment[]>;
  nextCommentId: number;
  createdSeq: number;
  /** Bumped on every git-state mutation (push, contents write, merge); fetch packs are cached against it. */
  version: number;
  /** Fetch pack cache: key `${version}:${wants}|${haves}|${shallow}|${depth}` → pack bytes. */
  packCache: Map<string, Buffer>;
}

export class Store {
  repos = new Map<string, Repo>();
  repoOrder: Repo[] = [];
  nextRepoDbId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  seq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const dbId = this.nextRepoDbId++;
    const repo: Repo = {
      dbId,
      gid: `R_${dbId}`,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      nextIssue: 1,
      labels: new Map(),
      pulls: [],
      nextPull: 1,
      comments: new Map(),
      nextCommentId: 1,
      createdSeq: this.seq++,
      version: 0,
      packCache: new Map(),
    };
    this.repos.set(key, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.key(owner, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  listRepos(owner: string): Repo[] {
    return this.repoOrder.filter((repo) => repo.owner === owner);
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const number = repo.nextIssue++;
    const idNum = this.nextIssueId++;
    const issue: Issue = {
      idNum,
      gid: `I_${repo.dbId}_${number}`,
      number,
      title,
      body,
      state: 'open',
      labelNames: [...labelNames],
      createdSeq: this.seq++,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextPull++;
    const idNum = this.nextPullId++;
    const pull: Pull = {
      idNum,
      gid: `PR_${repo.dbId}_${number}`,
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.seq++,
    };
    repo.pulls.push(pull);
    return pull;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    const idNum = repo.nextCommentId++;
    const comment: Comment = { idNum, gid: `C_${repo.dbId}_${idNum}`, body };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  /** Resolve a global id to its object (repo / issue / pull / comment). */
  resolveGlobalId(gid: string): { kind: 'repo' | 'issue' | 'pull' | 'comment'; repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    if (gid.startsWith('R_')) {
      const dbId = Number(gid.slice(2));
      const repo = this.repoOrder.find((candidate) => candidate.dbId === dbId);
      return repo === undefined ? null : { kind: 'repo', repo };
    }
    if (gid.startsWith('I_')) {
      const rest = gid.slice(2);
      const dash = rest.indexOf('_');
      if (dash < 0) return null;
      const repo = this.repoOrder.find((candidate) => candidate.dbId === Number(rest.slice(0, dash)));
      if (repo === undefined) return null;
      const issue = repo.issues.find((candidate) => candidate.number === Number(rest.slice(dash + 1)));
      return issue === undefined ? null : { kind: 'issue', repo, issue };
    }
    if (gid.startsWith('PR_')) {
      const rest = gid.slice(3);
      const dash = rest.indexOf('_');
      if (dash < 0) return null;
      const repo = this.repoOrder.find((candidate) => candidate.dbId === Number(rest.slice(0, dash)));
      if (repo === undefined) return null;
      const pull = repo.pulls.find((candidate) => candidate.number === Number(rest.slice(dash + 1)));
      return pull === undefined ? null : { kind: 'pull', repo, pull };
    }
    if (gid.startsWith('C_')) {
      const rest = gid.slice(2);
      const dash = rest.indexOf('_');
      if (dash < 0) return null;
      const repo = this.repoOrder.find((candidate) => candidate.dbId === Number(rest.slice(0, dash)));
      if (repo === undefined) return null;
      for (const list of repo.comments.values()) {
        const comment = list.find((candidate) => candidate.idNum === Number(rest.slice(dash + 1)));
        if (comment !== undefined) return { kind: 'comment', repo, comment };
      }
      return null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Repo graph helpers
// ---------------------------------------------------------------------------------------------

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getRef(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** Resolve a branch name, full ref or oid to a commit oid (or undefined). */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return repo.refs.get(`refs/heads/${ref}`);
}

/** First-parent walk from a tip (newest first). */
export function firstParentWalk(repo: Repo, tip: string, limit = 100000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && !seen.has(current) && out.length < limit) {
    seen.add(current);
    out.push(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    const parsed = parseCommit(object.data);
    current = parsed.parents[0];
  }
  return out;
}

/** Is `ancestor` reachable from `tip` (any parent path)? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The merge-base of two tips: the common ancestor closest to `headTip`. */
export function mergeBase(repo: Repo, headTip: string, baseTip: string): string | null {
  const baseAncestors = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [{ oid: baseTip, depth: 0 }];
  const seenBase = new Set<string>([baseTip]);
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    baseAncestors.set(oid, depth);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seenBase.has(parent)) {
        seenBase.add(parent);
        queue.push({ oid: parent, depth: depth + 1 });
      }
    }
  }
  const headQueue: Array<{ oid: string; depth: number }> = [{ oid: headTip, depth: 0 }];
  const seenHead = new Set<string>([headTip]);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (headQueue.length > 0) {
    const { oid, depth } = headQueue.shift()!;
    const baseDepth = baseAncestors.get(oid);
    if (baseDepth !== undefined) {
      const score = depth + baseDepth;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seenHead.has(parent)) {
        seenHead.add(parent);
        headQueue.push({ oid: parent, depth: depth + 1 });
      }
    }
  }
  return best;
}

export interface SendSet {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch sends: reachable from `wants`, minus what the client holds
 * (`haves`, where the walk stops at the request's shallow boundaries), limited by
 * `depth` when given. `shallow` lists the new boundary commits; `unshallow` lists
 * old boundaries that are now fully included.
 */
export function computeSendSet(repo: Repo, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | null): SendSet {
  const shallowSet = new Set(shallowIn);
  const held = new Set<string>();
  // What the client already holds: reachable from haves, stopping at shallow boundaries
  // (the client has the boundary commit itself, not its parents).
  for (const have of haves) {
    const queue: string[] = [have];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      held.add(oid);
      if (shallowSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        const parsed = parseCommit(object.data);
        queue.push(parsed.tree);
        for (const parent of parsed.parents) queue.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
  }
  // Reachable from wants, with the depth limit on commits.
  const wanted = new Map<string, GitObject>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) queue.push({ oid: want, depth: 0 });
  const visitedCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (visitedCommits.has(oid)) continue;
      visitedCommits.add(oid);
      if (depth !== null && d >= depth) continue;
      commitDepth.set(oid, d);
      wanted.set(oid, object);
      const parsed = parseCommit(object.data);
      if (!held.has(parsed.tree)) {
        const tree = repo.objects.get(parsed.tree);
        if (tree !== undefined) queue.push({ oid: parsed.tree, depth: d });
      }
      for (const parent of parsed.parents) {
        if (!visitedCommits.has(parent)) queue.push({ oid: parent, depth: d + 1 });
      }
    } else if (object.type === 'tree') {
      wanted.set(oid, object);
      for (const entry of parseTree(object.data)) {
        if (!wanted.has(entry.oid) && !held.has(entry.oid)) queue.push({ oid: entry.oid, depth: d });
      }
    } else if (object.type === 'tag') {
      wanted.set(oid, object);
      const target = parseTag(object.data).object;
      if (!wanted.has(target) && !held.has(target)) queue.push({ oid: target, depth: d });
    } else {
      wanted.set(oid, object);
    }
  }
  // Drop held objects (the queue above already avoids most, but trees/blobs reached
  // through a held commit's tree need the same treatment).
  for (const oid of [...wanted.keys()]) {
    if (held.has(oid)) wanted.delete(oid);
  }
  // Boundary commits: only a depth-limited fetch has shallow boundaries — the
  // deepest included commits (depth N-1) whose parents were cut off.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of commitDepth) {
      if (d === depth - 1) shallow.push(oid);
    }
    // Unshallow: old boundaries now included with all parents included.
    for (const oid of shallowIn) {
      if (!commitDepth.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => commitDepth.has(parent))) unshallow.push(oid);
    }
  }
  return { objects: wanted, shallow, unshallow };
}

/** Every file under a tree: path -> {oid, mode}. */
export function fileListAt(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees (null = empty). */
export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): FileChange[] {
  const oldFiles = fileListAt(repo, oldTree);
  const newFiles = fileListAt(repo, newTree);
  const changes: FileChange[] = [];
  for (const [path, entry] of newFiles) {
    const old = oldFiles.get(path);
    if (old === undefined) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (old.oid !== entry.oid) changes.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const [path, entry] of oldFiles) {
    if (!newFiles.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : 1));
  return changes;
}

/** Line counts for a changed file (multiset difference of lines). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldCount = count(oldLines);
  const newCount = count(newLines);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCount) additions += Math.max(0, n - (oldCount.get(line) ?? 0));
  for (const [line, n] of oldCount) deletions += Math.max(0, n - (newCount.get(line) ?? 0));
  return { additions, deletions };
}

/** Create a commit object in the repo. Returns its oid. */
export function createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_TS} +0000`;
  let header = `tree ${treeOid}\n`;
  for (const parent of parents) header += `parent ${parent}\n`;
  header += `author ${ident}\ncommitter ${ident}\n`;
  const data = Buffer.from(`${header}\n${text}`, 'utf8');
  return putObject(repo, 'commit', data);
}

/**
 * Return a new tree oid with `path` set to `blobOid` (or removed when null),
 * starting from `treeOid` (null = empty tree). Creates intermediate trees.
 */
export function updateTree(repo: Repo, treeOid: string | null, parts: readonly string[], blobOid: string | null): string {
  const object = treeOid === null ? undefined : repo.objects.get(treeOid);
  const entries = new Map<string, TreeEntry>();
  if (object !== undefined && object.type === 'tree') {
    for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
  }
  const [head, ...rest] = parts;
  if (head === undefined) throw new Error('empty path');
  if (rest.length === 0) {
    if (blobOid === null) entries.delete(head);
    else entries.set(head, { mode: '100644', name: head, oid: blobOid });
  } else {
    const child = entries.get(head);
    const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
    const newChild = updateTree(repo, childTree, rest, blobOid);
    const childObject = repo.objects.get(newChild);
    if (childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0) {
      entries.delete(head);
    } else {
      entries.set(head, { mode: '40000', name: head, oid: newChild });
    }
  }
  return putObject(repo, 'tree', buildTree([...entries.values()]));
}

/** Find the tree oid at `path` under `treeOid` (null when absent / not a tree). */
export function treeAtPath(repo: Repo, treeOid: string | null, path: string): { oid: string; type: 'tree' | 'blob' } | null {
  if (treeOid === null) return null;
  if (path === '' || path === '/') return { oid: treeOid, type: 'tree' };
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) return { oid: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob' };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** A fresh request id (deterministic counter, no randomness). */
export function newRequestId(counter: { value: number }): string {
  counter.value += 1;
  return `req-${counter.value}`;
}
