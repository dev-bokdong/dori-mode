import { existsSync } from "node:fs";

import type { Lane } from "./registry.ts";
import type { Ran, Runner } from "./run.ts";
import type { Operation, OperationState, OperationStore, ReadBack } from "./operations.ts";
import { parseSignal, splitDone } from "./signals.ts";

/**
 * SHA-bound branch cleanup (design 4.3, item 1.3). A close binds each `merged <repo>#N` signal of
 * the lane, and each lane worktree whose branch has a PR merged into the merge base (`ciMergeBase`), to `(repo, PR
 * number, base, merged head SHA)` read from GitHub. A worktree on that branch is removed only when its HEAD is exactly
 * the merged head; the branch is then deleted only when the local ref and the remote ref (when it still exists) still
 * point at that SHA, and the branch is not checked out anywhere, not protected and not named by another open lane's Done
 * line: the remote branch with a lease on that SHA (`git push --force-with-lease=<ref>:<sha> <remote> :<ref>`), then the
 * local one with a compare-and-delete (`git update-ref -d <ref> <sha>`). Anything else keeps the branch (and its
 * worktree) and reports why in the close receipt.
 */
export const BRANCH_DELETE = "branch-delete";
export const REMOTE_BRANCH_DELETE = "remote-branch-delete";

/** Never deleted, whatever a PR says (besides the PR's own base). */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "dev", "develop", "trunk", "release", "staging", "production"]);

export type Binding = { readonly repo: string; readonly n: string; readonly base: string; readonly branch: string; readonly sha: string };
/** A merged signal whose PR could not be bound: its repo's worktrees and branches are kept. */
export type Unbound = { readonly repo: string; readonly n: string; readonly error: string };

/** One local branch to delete: where (`gitDir`, the repo's common git dir) and which remote holds the PR. */
export type BranchTarget = Binding & { readonly gitDir: string; readonly remote: string };

/** The close's effect runner (done-flow's `act`): an operation when `operations` is on, a plain run otherwise. */
export type BranchAct = (action: string, target: string, effect: () => Promise<Ran>, readBack: ReadBack) =>
  Promise<{ readonly state: OperationState; readonly err: string; readonly out: string; readonly id?: string; readonly detail?: string }>;

const short = (sha: string): string => sha.slice(0, 10);
const SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 30_000;

/** Reads every merged signal's PR from GitHub. A PR that is not merged, from a fork or unreadable is Unbound. */
export const readBindings = async (done: string, run: Runner): Promise<(Binding | Unbound)[]> => {
  const out: (Binding | Unbound)[] = [];
  for (const part of splitDone(done)) {
    let parsed;
    try { parsed = parseSignal(part); } catch { continue; }
    if (parsed.kind !== "merged") continue;
    const sig = parsed;
    const r = await run(["gh", "pr", "view", sig.n, "--repo", sig.repo, "--json", "state,headRefName,headRefOid,baseRefName,isCrossRepository"]);
    const unbound = (error: string): Unbound => ({ repo: sig.repo, n: sig.n, error: error.replace(/\s+/g, " ").slice(0, 160) });
    if (r.code !== 0 || r.timedOut) { out.push(unbound(r.err || `gh exited ${r.code}`)); continue; }
    let j: { state?: string; headRefName?: string; headRefOid?: string; baseRefName?: string; isCrossRepository?: boolean };
    try { j = JSON.parse(r.out); } catch { out.push(unbound("unreadable gh answer")); continue; }
    if (j.state !== "MERGED") out.push(unbound(`PR is ${j.state ?? "unknown"}`));
    else if (j.isCrossRepository) out.push(unbound("head branch is in a fork"));
    else if (!j.headRefName || !j.baseRefName || !SHA.test(j.headRefOid ?? "")) out.push(unbound("PR head or base missing"));
    else out.push({ repo: sig.repo, n: sig.n, base: j.baseRefName, branch: j.headRefName, sha: j.headRefOid ?? "" });
  }
  return out;
};

const isUnbound = (b: Binding | Unbound): b is Unbound => "error" in b;

/** `owner/repo` of a remote URL on any host (its last two path segments), or undefined. */
const repoOfUrl = (url: string): string | undefined => {
  const path = url.trim().replace(/\.git\/?$/, "").replace(/\/+$/, "").replace(/^[^/]*:(?!\/)/, "/");
  const m = /([\w.-]+)\/([\w.-]+)$/.exec(path);
  return m ? `${m[1]}/${m[2]}` : undefined;
};

type MergedPull = { number?: number; headRefName?: string; headRefOid?: string; baseRefName?: string; isCrossRepository?: boolean };

/**
 * Binds each worktree's branch to the PR merged from it into `base` (no Done signal needed): the merged PR whose head is
 * the worktree's HEAD, else the newest one (whose head then differs, so the worktree and branch are kept). A branch with
 * no merged PR, a protected branch or a detached HEAD gives nothing; a lookup that fails is one receipt note.
 */
export const readBranchBindings = async (
  run: Runner, worktrees: readonly string[], base: string, exists: (p: string) => boolean = existsSync,
): Promise<{ readonly bindings: Binding[]; readonly notes: string[]; readonly atHead: Binding[] }> => {
  const bindings: Binding[] = [];
  /** Bindings whose merged head is exactly the worktree's HEAD: the worktree's work is what was merged. */
  const atHead: Binding[] = [];
  const notes: string[] = [];
  for (const wt of worktrees) {
    if (!exists(wt)) continue;
    const current = await run(["git", "-C", wt, "symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
    const branch = current.out.trim();
    if (current.code !== 0 || !branch || branch === base || PROTECTED_BRANCHES.has(branch)) continue;
    const url = await run(["git", "-C", wt, "remote", "get-url", "origin"], { timeoutMs: GIT_TIMEOUT_MS });
    const repo = url.code === 0 ? repoOfUrl(url.out) : undefined;
    if (!repo) continue;
    if (bindings.some((b) => b.repo.toLowerCase() === repo.toLowerCase() && b.branch === branch)) continue;
    const r = await run(["gh", "pr", "list", "--repo", repo, "--state", "merged", "--base", base, "--head", branch,
      "--json", "number,headRefName,headRefOid,baseRefName,isCrossRepository", "--limit", "20"]);
    const note = (why: string) => notes.push(`branch cleanup skipped for ${repo} branch ${branch}: ${why.replace(/\s+/g, " ").slice(0, 160)}`);
    if (r.code !== 0 || r.timedOut) { note(r.err || `gh exited ${r.code}`); continue; }
    let pulls: MergedPull[];
    try { pulls = JSON.parse(r.out) as MergedPull[]; } catch { note("unreadable gh answer"); continue; }
    if (!Array.isArray(pulls)) { note("unreadable gh answer"); continue; }
    const ours = pulls.filter((p) => !p.isCrossRepository && p.headRefName === branch && p.baseRefName === base && typeof p.number === "number" && SHA.test(p.headRefOid ?? ""));
    if (!ours.length) continue;
    const head = await run(["git", "-C", wt, "rev-parse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
    const exact = head.code === 0 ? ours.find((p) => p.headRefOid === head.out.trim()) : undefined;
    const pick = exact ?? ours[0];
    if (!pick) continue;
    const binding: Binding = { repo, n: String(pick.number), base, branch, sha: pick.headRefOid ?? "" };
    bindings.push(binding);
    if (exact) atHead.push(binding);
  }
  return { bindings, notes, atHead };
};

/** The remote of a checkout (`git <where> remote -v`) whose URL is `owner/repo` on any host, or undefined. */
const remoteFor = async (run: Runner, where: readonly string[], repo: string): Promise<string | undefined> => {
  const r = await run(["git", ...where, "remote", "-v"], { timeoutMs: GIT_TIMEOUT_MS });
  if (r.code !== 0) return undefined;
  const tail = `/${repo.toLowerCase()}`;
  for (const line of r.out.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (!name || !url) continue;
    const path = url.toLowerCase().replace(/\.git\/?$/, "").replace(/\/+$/, "").replace(/^[^/]*:(?!\/)/, "/");
    if (path.endsWith(tail)) return name;
  }
  return undefined;
};

/** The repository's common git dir (shared by all its worktrees), absolute; undefined when it is not a git checkout. */
const commonDir = async (run: Runner, dir: string): Promise<string | undefined> => {
  const r = await run(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
};

export type BranchPlan = {
  /** Worktrees that must stay, with why (a commit after the merge, an unreadable PR). */
  readonly holds: ReadonlyMap<string, string>;
  readonly targets: readonly BranchTarget[];
  /** Merged signals that could not be bound, one receipt line each. */
  readonly notes: readonly string[];
  /** Candidate worktrees (the lane's own cwd) that sit exactly at a merged head: these are removed too. */
  readonly adopted: readonly string[];
};

export type BranchPlanOptions = {
  /** The merge base (`ciMergeBase`): each worktree's branch is also bound to a PR merged from it into this base. */
  readonly base?: string;
  /**
   * Linked worktrees the close does not remove by itself (the lane's cwd): each is removed only when it is a linked
   * worktree whose branch is bound to a merged PR and whose HEAD is exactly the merged head.
   */
  readonly candidates?: readonly string[];
};

const targetKey = (t: Pick<Binding, "repo" | "n" | "sha">): string => `${t.repo}#${t.n}@${t.sha}`;

/**
 * Before any worktree is removed: binds the lane's merged PRs, decides which worktrees stay, and finds the local branch
 * to delete in each repository the lane works in. Each target is recorded (planned, with its git dir) in `store`, so a
 * close resumed after its worktree is gone still knows where the branch lives.
 */
export const planBranchCleanup = async (
  run: Runner, lane: Lane, worktrees: readonly string[], root: string, store: OperationStore | undefined, now: () => number, exists: (p: string) => boolean = existsSync,
  opts: BranchPlanOptions = {},
): Promise<BranchPlan> => {
  const signalled = await readBindings(lane.done, run);
  const candidates: string[] = [];
  for (const c of opts.candidates ?? []) {
    if (worktrees.includes(c) || !exists(c)) continue;
    // Only a linked worktree: the main checkout of a repository is never removed.
    const own = await run(["git", "-C", c, "rev-parse", "--path-format=absolute", "--git-dir"], { timeoutMs: GIT_TIMEOUT_MS });
    const common = await commonDir(run, c);
    if (own.code === 0 && common && own.out.trim() !== common) candidates.push(c);
  }
  const fromBranches = opts.base ? await readBranchBindings(run, [...worktrees, ...candidates], opts.base, exists) : { bindings: [], notes: [], atHead: [] };
  const bindings: (Binding | Unbound)[] = [...signalled, ...fromBranches.bindings.filter((b) => !signalled.some((s) => !isUnbound(s) && targetKey(s) === targetKey(b)))];
  const holds = new Map<string, string>();
  const adopted: string[] = [];
  const notes = [...bindings.filter(isUnbound).map((b) => `branch cleanup skipped for ${b.repo}#${b.n}: ${b.error}`), ...fromBranches.notes];
  const dirs = new Set<string>();
  for (const wt of [...worktrees, ...candidates]) {
    if (!exists(wt)) continue;
    const dir = await commonDir(run, wt);
    if (dir) dirs.add(dir);
    const current = await run(["git", "-C", wt, "symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
    for (const b of bindings) {
      if (!(await remoteFor(run, ["-C", wt], b.repo))) continue;
      if (isUnbound(b)) { holds.set(wt, `${b.repo}#${b.n} could not be bound: ${b.error}`); break; }
      if (current.code !== 0 || current.out.trim() !== b.branch) continue;
      const head = await run(["git", "-C", wt, "rev-parse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
      const tip = head.out.trim();
      if (head.code !== 0) { holds.set(wt, `cannot read HEAD of branch ${b.branch}: ${(head.err || head.out).slice(0, 120)}`); break; }
      if (tip !== b.sha) { holds.set(wt, `branch ${b.branch} tip ${short(tip)} is not the merged head ${short(b.sha)} of ${b.repo}#${b.n}`); break; }
      if (candidates.includes(wt)) adopted.push(wt);
      break;
    }
  }
  if (exists(root)) {
    const dir = await commonDir(run, root);
    if (dir) dirs.add(dir);
  }
  const targets = new Map<string, BranchTarget>();
  // Targets an interrupted close recorded: their worktree may be gone, so they are not found again below.
  for (const op of store?.list({ lane: lane.key }).filter((o) => o.action === BRANCH_DELETE && o.state !== "verified") ?? []) {
    try { targets.set(op.target, JSON.parse(op.data ?? "") as BranchTarget); } catch { /* a row without data is not resumable here */ }
  }
  for (const b of bindings) {
    if (isUnbound(b) || targets.has(targetKey(b))) continue;
    for (const gitDir of dirs) {
      const remote = await remoteFor(run, ["--git-dir", gitDir], b.repo);
      if (remote) { targets.set(targetKey(b), { ...b, gitDir, remote }); break; }
    }
  }
  if (store) {
    for (const [key, t] of targets) {
      if (!store.get(`${lane.key}/${BRANCH_DELETE}/${key}`)) store.put(planned(lane.key, key, t, now()));
    }
  }
  return { holds, targets: [...targets.values()], notes, adopted: adopted.filter((wt) => !holds.has(wt)) };
};

const planned = (lane: string, target: string, t: BranchTarget, at: number): Operation => ({
  id: `${lane}/${BRANCH_DELETE}/${target}`, lane, action: BRANCH_DELETE, target, state: "planned", detail: "planned", data: JSON.stringify(t), attempts: 0, at, updatedAt: at,
});

/** Why another open lane's Done line names the same PR, or undefined. */
const sharedBy = (others: readonly Lane[], t: Binding): string | undefined => {
  const want = `${t.repo.toLowerCase()}#${t.n}`;
  return others.find((l) => splitDone(l.done).some((part) => {
    try { const s = parseSignal(part); return s.kind === "merged" && `${s.repo.toLowerCase()}#${s.n}` === want; } catch { return false; }
  }))?.key;
};

export type BranchResult = {
  readonly line: string;
  readonly step?: Awaited<ReturnType<BranchAct>>;
  readonly kept?: string;
  /** The remote branch's receipt line, when the remote branch was read. */
  readonly remoteLine?: string;
  readonly remoteStep?: Awaited<ReturnType<BranchAct>>;
};

/**
 * After the worktrees: re-reads the local ref, the worktree list and the remote ref, then deletes the local branch only
 * if all still agree with the merged head SHA. The delete itself compares and swaps, so a commit landing between the
 * read and the delete keeps the branch. Returns one receipt line; `kept` is set when the branch stays.
 */
export const deleteBranch = async (run: Runner, act: BranchAct, t: BranchTarget, otherOpen: readonly Lane[]): Promise<BranchResult> => {
  const ref = `refs/heads/${t.branch}`;
  const git = ["git", "--git-dir", t.gitDir];
  const kept = (why: string): BranchResult => ({ line: `branch ${t.branch} kept: ${why}`, kept: why });
  if (PROTECTED_BRANCHES.has(t.branch) || t.branch === t.base) return kept(`protected (base ${t.base} of ${t.repo}#${t.n})`);
  const sharing = sharedBy(otherOpen, t);
  if (sharing) return kept(`open lane ${sharing} also names ${t.repo}#${t.n}`);
  const readLocal = async (): Promise<{ readonly code: number; readonly sha: string }> => {
    const r = await run([...git, "rev-parse", "--verify", "--quiet", ref], { timeoutMs: GIT_TIMEOUT_MS });
    return { code: r.code, sha: r.out.trim() };
  };
  const local = await readLocal();
  const readBack: ReadBack = async () => {
    const r = await readLocal();
    return r.code === 1 ? "done" : r.code === 0 ? "not-done" : "unknown";
  };
  const effect = () => run([...git, "update-ref", "-d", ref, t.sha], { timeoutMs: GIT_TIMEOUT_MS });
  const key = targetKey(t);
  const readRemote = async (): Promise<{ readonly code: number; readonly sha: string; readonly err: string }> => {
    const r = await run([...git, "ls-remote", t.remote, ref], { timeoutMs: GIT_TIMEOUT_MS });
    return { code: r.code, sha: r.out.trim().split(/\s+/)[0] ?? "", err: (r.err || r.out).replace(/\s+/g, " ").slice(0, 120) };
  };
  if (local.code === 1) {
    const remote = await deleteRemote(run, act, t, key, readRemote);
    if (remote.step?.state === "ambiguous") return { line: "", remoteStep: remote.step };
    const step = await act(BRANCH_DELETE, key, effect, readBack);
    return { line: `branch ${t.branch} already gone`, step, remoteLine: remote.line, remoteStep: remote.step };
  }
  if (local.code !== 0) return kept(`cannot read ${ref} in ${t.gitDir}`);
  if (local.sha !== t.sha) return kept(`tip ${short(local.sha)} is not the merged head ${short(t.sha)} of ${t.repo}#${t.n} (a commit after the merge)`);
  const listed = await run([...git, "worktree", "list", "--porcelain"], { timeoutMs: GIT_TIMEOUT_MS });
  if (listed.code !== 0) return kept("cannot read the worktree list");
  if (listed.out.split("\n").includes(`branch ${ref}`)) return kept("checked out in a worktree");
  const remote = await readRemote();
  if (remote.code !== 0) return kept(`cannot read ${t.remote}/${t.branch}: ${remote.err}`);
  if (remote.sha && remote.sha !== t.sha) return kept(`${t.remote}/${t.branch} is at ${short(remote.sha)}, not the merged head ${short(t.sha)} of ${t.repo}#${t.n} (a commit pushed after the merge)`);
  // Remote first: a close interrupted between the two still finds the local branch, and with it this target, on resume.
  const remoteDone = await deleteRemote(run, act, t, key, readRemote);
  if (remoteDone.step?.state === "ambiguous") return { line: "", remoteStep: remoteDone.step };
  const remoteFields = { remoteLine: remoteDone.line, remoteStep: remoteDone.step };
  const step = await act(BRANCH_DELETE, key, effect, readBack);
  if (step.state === "verified") return { line: `branch ${t.branch} deleted (${t.repo}#${t.n} merged head ${short(t.sha)})`, step, ...remoteFields };
  if (step.state === "ambiguous") return { line: "", step };
  const after = await readLocal();
  return { ...kept(after.code === 0 && after.sha !== t.sha ? `moved to ${short(after.sha)} while deleting` : `delete failed: ${(step.err || step.out).replace(/\s+/g, " ").slice(0, 120)}`), step, ...remoteFields };
};

/**
 * Deletes the PR's remote branch while it still points at the merged head: the push carries a lease on that SHA, so a
 * commit pushed meanwhile makes the remote refuse. A remote branch already gone (GitHub deletes merged heads) is no line.
 */
const deleteRemote = async (
  run: Runner, act: BranchAct, t: BranchTarget, key: string,
  readRemote: () => Promise<{ readonly code: number; readonly sha: string; readonly err: string }>,
): Promise<{ readonly line?: string; readonly step?: Awaited<ReturnType<BranchAct>> }> => {
  const name = `${t.remote}/${t.branch}`;
  const now = await readRemote();
  if (now.code !== 0) return { line: `remote branch ${name} kept: cannot read it: ${now.err}` };
  if (!now.sha) return {};
  if (now.sha !== t.sha) return { line: `remote branch ${name} kept: at ${short(now.sha)}, not the merged head ${short(t.sha)} of ${t.repo}#${t.n}` };
  const ref = `refs/heads/${t.branch}`;
  const readBack: ReadBack = async () => {
    const r = await readRemote();
    return r.code !== 0 ? "unknown" : r.sha ? "not-done" : "done";
  };
  const step = await act(REMOTE_BRANCH_DELETE, key, () => run(["git", "--git-dir", t.gitDir, "push", `--force-with-lease=${ref}:${t.sha}`, t.remote, `:${ref}`], { timeoutMs: 60_000 }), readBack);
  if (step.state === "verified") return { line: `remote branch ${name} deleted (${t.repo}#${t.n} merged head ${short(t.sha)})`, step };
  if (step.state === "ambiguous") return { step };
  return { line: `remote branch ${name} kept: delete failed: ${(step.err || step.out).replace(/\s+/g, " ").slice(0, 120)}`, step };
};
