/**
 * Read-only, confined access to an untrusted source checkout.
 *
 * The Terraform docs generator reads third-party repositories (the provider and cloudflare-go).
 * Their contents are treated as untrusted data:
 *
 * - paths must be relative and may not escape the root (`..`, absolute paths, NUL bytes);
 * - symbolic links are never followed, so a checkout cannot redirect reads to local files
 *   such as `~/.ssh/id_rsa` and leak them into the generated output;
 * - resolved real paths must stay inside the root, which also covers symlinked parent directories.
 *
 * Nothing in a checkout is executed.
 */

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class SourceTree {
  readonly label: string;
  readonly root: string;

  private constructor(label: string, root: string) {
    this.label = label;
    this.root = root;
  }

  /** Opens `directory` as a confined tree. `label` names it in error messages. */
  static async open(label: string, directory: string): Promise<SourceTree> {
    let root: string;
    try {
      root = await realpath(directory);
    } catch (cause) {
      throw new Error(`${label}: ${directory} does not exist`, { cause });
    }
    if (!(await stat(root)).isDirectory()) {
      throw new Error(`${label}: ${directory} is not a directory`);
    }
    return new SourceTree(label, root);
  }

  private resolve(relativePath: string): string {
    const segments = relativePath.split(/[\\/]/);
    if (
      relativePath.length === 0 ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath) ||
      segments.some((segment) => segment === '..')
    ) {
      throw new Error(`${this.label}: refusing to read unsafe path ${JSON.stringify(relativePath)}`);
    }
    return path.join(this.root, ...segments);
  }

  private async assertInside(absolutePath: string, relativePath: string): Promise<void> {
    const real = await realpath(absolutePath);
    if (real !== this.root && !real.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`${this.label}: ${relativePath} resolves outside the checkout`);
    }
  }

  /** Reads a UTF-8 file, or returns undefined when it does not exist. Symlinks are rejected. */
  async readText(relativePath: string): Promise<string | undefined> {
    const absolute = this.resolve(relativePath);
    // A missing file is the one error that means "not there"; anything else is a real failure.
    const info = await lstat(absolute).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (!info) {
      return undefined;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${this.label}: ${relativePath} is a symbolic link`);
    }
    if (!info.isFile()) {
      throw new Error(`${this.label}: ${relativePath} is not a regular file`);
    }
    await this.assertInside(absolute, relativePath);
    return readFile(absolute, 'utf8');
  }

  /** Reads a file that must exist. */
  async requireText(relativePath: string): Promise<string> {
    const text = await this.readText(relativePath);
    if (text === undefined) {
      throw new Error(`${this.label}: missing ${relativePath}`);
    }
    return text;
  }

  /**
   * Lists regular files under `relativeDirectory` (recursively), as `/`-separated paths relative
   * to the root. Symbolic links are skipped and never traversed.
   */
  async listFiles(relativeDirectory: string, include: (relativePath: string) => boolean): Promise<string[]> {
    const absolute = this.resolve(relativeDirectory);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info?.isDirectory()) {
      return [];
    }
    await this.assertInside(absolute, relativeDirectory);
    // Walk explicitly instead of `readdir({ recursive: true })`: on Node 26 it follows
    // symlinked directories, which could escape the checkout. Non-recursive `readdir` entries
    // describe the link itself, so symlinks are neither files nor directories here.
    const files: string[] = [];
    const pending = [absolute];
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile()) {
          const relative = path.relative(this.root, entryPath).split(path.sep).join('/');
          if (include(relative)) {
            files.push(relative);
          }
        }
      }
    }
    return files.sort();
  }

  /** Commit checked out in this tree, read from `.git` without running git. */
  async gitCommit(): Promise<string | undefined> {
    const head = (await this.readText('.git/HEAD').catch(() => undefined))?.trim();
    if (!head) {
      return undefined;
    }
    if (/^[0-9a-f]{40}$/.test(head)) {
      return head;
    }
    const ref = head.match(/^ref: (refs\/[\w./-]+)$/)?.[1];
    if (!ref) {
      return undefined;
    }
    const loose = (await this.readText(`.git/${ref}`).catch(() => undefined))?.trim();
    if (loose && /^[0-9a-f]{40}$/.test(loose)) {
      return loose;
    }
    const packed = await this.readText('.git/packed-refs').catch(() => undefined);
    return packed?.match(new RegExp(`^([0-9a-f]{40}) ${ref.replaceAll('.', '\\.')}$`, 'm'))?.[1];
  }
}
