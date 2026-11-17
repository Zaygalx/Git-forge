// Git smart HTTP: info/refs advertisements (v0 + v2), v2 ls-refs / fetch,
// v0 fetch, and v0 receive-pack (push). All framing is pkt-lines; packs are
// plain (no deltas emitted) with a valid SHA-1 trailer.

import {
  ZERO_OID,
  computeSendSet,
  decodePktLines,
  encodePktLines,
  getObject,
  isAncestor,
  isOid,
  parseTag,
  pktFlush,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

const UPLOAD_V0_CAPS = 'side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** Refs sorted by name, HEAD first is handled by the caller. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The commit a tag object peels to (following nested tags). */
function peelTag(repo: Repo, tagOid: string): string | null {
  let current = tagOid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = getObject(repo, current);
    if (object === undefined || object.type !== 'tag') return object !== undefined && object.type === 'commit' ? current : null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** v0 ref advertisement lines (after the service preamble + flush). */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const first = mainTip !== undefined ? mainTip : refs[0]!.oid;
  lines.push(pktLine(`${first} HEAD\0${caps}\n`));
  for (const ref of refs) {
    lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
    if (ref.name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  return lines;
}

export function uploadPackAdvertisement(repo: Repo, version2: boolean): GitResponse {
  if (version2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ]);
    return { status: 200, contentType: UPLOAD_AD_CT, body };
  }
  const body = Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    ...v0RefLines(repo, UPLOAD_V0_CAPS),
    pktFlush(),
  ]);
  return { status: 200, contentType: UPLOAD_AD_CT, body };
}

export function receivePackAdvertisement(repo: Repo): GitResponse {
  const body = Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    pktFlush(),
    ...v0RefLines(repo, RECEIVE_V0_CAPS),
    pktFlush(),
  ]);
  return { status: 200, contentType: RECEIVE_AD_CT, body };
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line\n') };
  }
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (!seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    if (keep('HEAD')) lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  } else {
    if (prefixes.length === 0 && mainTip !== undefined) {
      lines.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      lines.push(pktLine(`${line}\n`));
    }
  }
  lines.push(pktFlush());
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(lines) };
}

// ---------------------------------------------------------------------------------------------
// Fetch (v2 + v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

function fetchResponse(repo: Repo, args: FetchArgs, version2: boolean): GitResponse {
  const { objects, shallow, unshallow } = computeSendSet(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (version2) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktFlush());
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    if (objects.size > 0) {
      // Identical fetches (the 50 concurrent shallow clones all want the same
      // tip at the same depth) recompute the same pack; cache it per version.
      const cacheKey = `${repo.version}:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth}`;
      let pack = repo.packCache.get(cacheKey);
      if (pack === undefined) {
        pack = writePack(objects);
        repo.packCache.set(cacheKey, pack);
      }
      parts.push(pktLine('packfile\n'));
      for (const packet of sidebandWrap(pack)) parts.push(packet);
      parts.push(pktFlush());
    }
  } else {
    parts.push(pktLine('NAK\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    if (objects.size > 0) {
      const cacheKey = `${repo.version}:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth}`;
      let pack = repo.packCache.get(cacheKey);
      if (pack === undefined) {
        pack = writePack(objects);
        repo.packCache.set(cacheKey, pack);
      }
      for (const packet of sidebandWrap(pack)) parts.push(packet);
    }
    parts.push(pktFlush());
  }
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
}

export function handleUploadPack(repo: Repo, body: Buffer, gitProtocol2: boolean): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line\n') };
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (lines.length === 0) return { status: 400, contentType: 'text/plain', body: Buffer.from('empty request\n') };
  const first = lines[0]!;
  if (first.startsWith('command=ls-refs')) {
    return handleLsRefs(repo, body);
  }
  if (first.startsWith('command=fetch')) {
    return fetchResponse(repo, parseFetchArgs(lines.slice(1)), true);
  }
  if (first.startsWith('want ')) {
    // v0 fetch: wants, shallow/deepen, flush, haves, done, flush.
    return fetchResponse(repo, parseFetchArgs(lines), false);
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown git-upload-pack command\n') };
}

// ---------------------------------------------------------------------------------------------
// Receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  // Parse command pkt-lines until the flush; the rest is the pack.
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = body.length;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const head = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length');
      const length = parseInt(head, 16);
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length === 1) {
        offset += 4;
        continue;
      }
      if (length < 4 || offset + length > body.length) throw new Error('pkt-line out of range');
      const payload = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      const nul = payload.indexOf('\0');
      const text = nul >= 0 ? payload.slice(0, nul) : payload;
      const parts = text.split(' ');
      if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) throw new Error('bad push command');
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
      offset += length;
    }
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line\n') };
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('no push commands\n') };
  }

  const reportLines: string[] = [];
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  let packed: Map<string, GitObject> | null = null;
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackError = 'missing pack';
    } else {
      try {
        packed = readPack(packBytes);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  if (unpackError === null && packed !== null) {
    for (const [oid, object] of packed) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    reportLines.push('unpack ok');
  } else if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}`);
  } else {
    reportLines.push('unpack ok');
  }

  let changed = false;
  for (const command of commands) {
    if (unpackError !== null) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old value does not match`);
      } else {
        repo.refs.delete(command.ref);
        changed = true;
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} unable to update`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        changed = true;
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} old value does not match`);
      continue;
    }
    if (command.newOid === current || isAncestor(repo, current, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      reportLines.push(`ok ${command.ref}`);
    } else {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    }
  }
  if (changed) repo.version += 1;

  const reportText = encodePktLines(reportLines.map((line) => `${line}\n`));
  const bodyOut = Buffer.concat([...sidebandWrap(reportText), pktFlush()]);
  return { status: 200, contentType: RECEIVE_RESULT_CT, body: bodyOut };
}

// ---------------------------------------------------------------------------------------------
// Dispatch: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
// ---------------------------------------------------------------------------------------------

function notFoundJson(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
}

/**
 * Route one git smart-HTTP request. The client sends `Git-Protocol: version=2`
 * only for git-upload-pack (when it wants v2); receive-pack is always v0.
 * A missing repo is 404 and the server stays up.
 */
export function handleGit(
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  suffix: string,
  body: Buffer,
  query: URLSearchParams,
  gitProtocol2: boolean,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFoundJson();

  if (method === 'GET' && suffix === '/info/refs') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') return uploadPackAdvertisement(repo, gitProtocol2);
    if (service === 'git-receive-pack') return receivePackAdvertisement(repo);
    return notFoundJson();
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    return handleUploadPack(repo, body, gitProtocol2);
  }
  if (method === 'POST' && suffix === '/git-receive-pack') {
    return handleReceivePack(repo, body);
  }
  return notFoundJson();
}
