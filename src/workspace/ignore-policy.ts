import { readFile } from 'node:fs/promises';
import ignore, { type Ignore } from 'ignore';

const defaults = ['.git/**', 'node_modules/**', 'target/**', 'dist/**', 'build/**', 'coverage/**', '.idea/**', '.vscode/**', '.gradle/**', '.mvn/wrapper/*.jar', 'vendor/**', '__pycache__/**', '*.class', '*.jar', '*.war', '*.zip'];

export class IgnorePolicy {
  readonly #matcher: Ignore;
  private constructor(matcher: Ignore) { this.#matcher = matcher; }
  static async create(root: string): Promise<IgnorePolicy> {
    const matcher = ignore().add(defaults);
    try { matcher.add(await readFile(`${root}/.chatgpt-mcp-bridge-ignore`, 'utf8')); } catch { /* optional */ }
    return new IgnorePolicy(matcher);
  }
  isIgnored(path: string): boolean { return path !== '.' && this.#matcher.ignores(path.replaceAll('\\', '/').replace(/^\.\//u, '')); }
}
