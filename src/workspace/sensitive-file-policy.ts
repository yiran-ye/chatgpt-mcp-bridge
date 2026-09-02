const exact = new Set([
  '.env', 'id_rsa', 'id_ed25519', 'credentials.json', 'credentials.yml', 'credentials.yaml',
  'secrets.json', 'secrets.yml', 'secrets.yaml', 'application-prod.yml', 'application-prod.yaml',
  'application-prod.properties', 'bootstrap-prod.yml', 'bootstrap-prod.yaml', 'bootstrap-prod.properties',
  'kubeconfig', '.npmrc', '.pypirc', '.netrc',
]);

export function isSensitive(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1) ?? normalized;
  if (exact.has(name) || /^\.env\./u.test(name) || /^id_(?:rsa|ed25519)\./u.test(name)) return true;
  if (/\.(?:pem|key|p12|pfx)$/iu.test(name) || /^service-account.*\.json$/iu.test(name)) return true;
  return normalized === '.docker/config.json' || normalized.endsWith('/.docker/config.json');
}
