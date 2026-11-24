// Secret-looking files: never indexed, never read for excerpts, never candidates, never sent to any model.
// Applied to every path the scout touches (index, excerpts, import resolution, candidates).
import path from "node:path";

const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|secrets?)\//i;
const SECRET_BASE: RegExp[] = [
  /^\.env(\..*)?$/i, /\.env$/i, // .env, .env.local, prod.env (".env.example" too: cheap to skip)
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|crt|cer|der|ovpn|ppk)$/i,
  /^id_[a-z0-9]+(\.pub)?$/i, // id_rsa, id_ed25519(.pub)
  /^\.(netrc|npmrc|pypirc|pgpass|htpasswd|git-credentials|dockercfg)$/i, /^auth\.json$/i,
];
// Name-based rules (*key*, credentials*, secrets*, tokens*, *password*) only for data-like files: a note or source file
// named `signing-key.ts` / `keys-and-access.md` is documentation or code, not a secret store.
const NAMED: RegExp[] = [
  /(^|[^a-z])(api|private|secret|access|signing|ssh|gpg|master|encryption)?[-_.]?keys?([^a-z]|$)/i, // key.json, api_key.txt (not keyboard / monkey)
  /^credentials?([-_.].*)?$/i, /^secrets?([-_.].*)?$/i, /^tokens?([-_.].*)?$/i, /(^|[-_.])(password|passwd)s?([-_.]|$)/i,
];
const DOC_OR_CODE = /\.(md|mdx|markdown|rst|adoc|org|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|sh|sql|vue|svelte|html|css)$/i;

export function isSecretPath(p: string): boolean {
  const s = p.replace(/\\/g, "/");
  if (SECRET_DIRS.test(s)) return true;
  const b = path.basename(s);
  if (SECRET_BASE.some((re) => re.test(b))) return true;
  return !DOC_OR_CODE.test(b) && NAMED.some((re) => re.test(b));
}

// ---------------- content redaction (pi-scout) ----------------
// Secret-looking values inside ordinary files (a token pasted in a note, a password in a config sample) are replaced by
// [redacted] before any text reaches a model (digests, overview, task text). Conservative patterns: known token formats,
// "key = value" assignments with a secret-like key, credentials in URLs, private key blocks, and long mixed-case
// alphanumeric runs. False positives only hide a value from the researcher; they never change a locator.
const REDACT: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,})\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]"], // JWT
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+\/=-]{16,}/gi, "$1 [redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@\/]+:[^\s@\/]+@/gi, "$1[redacted]@"], // user:pass@ in URLs
  // key: value / key = value with a secret-like key (EN/FR); the value is replaced, the key kept
  [/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|secret|token|passwd|password|passphrase|pwd|mot[_ -]de[_ -]passe|mdp|client[_-]?secret|access[_-]?key|private[_-]?key)(?:[_-][A-Za-z0-9]+)*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi, (m, k, sep, v) => (/[^A-Za-zÀ-ÿ]/.test(v) || v.length >= 16 ? `${k}${sep}[redacted]` : m)],
  // long opaque runs: ≥ 32 chars mixing upper, lower and digits (not words, not hex hashes)
  [/\b(?=[A-Za-z0-9_+\/-]*[A-Z])(?=[A-Za-z0-9_+\/-]*[a-z])(?=[A-Za-z0-9_+\/-]*\d)[A-Za-z0-9_+\/-]{32,}={0,2}/g, "[redacted]"],
];
export function redactSecrets(text: string): string {
  let s = String(text ?? "");
  for (const [re, rep] of REDACT) s = s.replace(re, rep as any);
  return s;
}
