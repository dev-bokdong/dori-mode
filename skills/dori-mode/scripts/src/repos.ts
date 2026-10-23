import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class ReposError extends Error {
  readonly name = "ReposError";
}

const normalize = (value: unknown): string => {
  if (typeof value !== "string") throw new ReposError("GitHub repo must be owner/repo");
  const repo = value.trim().toLowerCase();
  const [owner = "", name = "", extra] = repo.split("/");
  if (extra !== undefined || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner) ||
      owner.includes("--") || !/^[a-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") {
    throw new ReposError(`invalid GitHub repo ${JSON.stringify(value)}; use owner/repo`);
  }
  return repo;
};

/** Machine-local additions to the watched set; every read sees CLI/setup changes. */
export class Repos {
  private readonly path: string;

  constructor(private readonly stateDir: string) {
    this.path = join(stateDir, "github-repos.json");
  }

  list(): string[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      if (e instanceof SyntaxError) throw new ReposError(`${this.path} is not valid JSON`);
      throw e;
    }
    if (!Array.isArray(raw)) throw new ReposError(`${this.path} must hold a JSON array of owner/repo strings`);
    return [...new Set(raw.map(normalize))];
  }

  add(repo: string): void {
    const normalized = normalize(repo);
    this.replace([...this.list(), normalized]);
  }

  remove(repo: string): void {
    const normalized = normalize(repo);
    this.replace(this.list().filter((entry) => entry !== normalized));
  }

  replace(repos: readonly string[]): void {
    const next = [...new Set(repos.map(normalize))];
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(tmp, this.path);
      const dir = openSync(this.stateDir, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
