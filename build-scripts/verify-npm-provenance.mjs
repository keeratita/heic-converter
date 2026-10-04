#!/usr/bin/env node
// Publish gate (ESM). Run via `npm run verify:provenance [version]`.
//
// Publishing goes through .github/workflows/publish.yml, which gets an npm
// attestation from OIDC trusted publishing. That attestation is what lets
// consumers (and scanners such as Socket) tie the tarball to this repository's
// CI — but it fails *silently*: a manual `npm publish` from a laptop, an
// expired `id-token: write` permission, or a registry hiccup all produce a
// perfectly installable package with no provenance at all.
//
// So check the registry's own record after publishing: the SLSA attestation,
// the gitHead that maps the tarball to a commit, and a sha512 integrity.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Pure check over a registry document, so the assertions are unit-testable. */
export function inspectRegistryDoc(doc, { name = PKG.name, version = PKG.version } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object') {
    return [`no registry document for ${name}@${version}`];
  }
  const attestations = doc.dist?.attestations;
  if (!attestations?.url) {
    problems.push('dist.attestations.url is missing — the package was not published with provenance');
  }
  const predicate = doc.dist?.attestations?.provenance?.predicateType;
  if (attestations?.url && !String(predicate).startsWith('https://slsa.dev/provenance')) {
    problems.push(`attestation predicateType is ${JSON.stringify(predicate)}, expected a SLSA provenance statement`);
  }
  if (!doc.gitHead) {
    problems.push('gitHead is missing — the tarball cannot be tied back to a commit');
  }
  if (!String(doc.dist?.integrity ?? '').startsWith('sha512-')) {
    problems.push('dist.integrity is missing or not sha512');
  }
  return problems;
}

async function fetchRegistryDoc(registry, name, version) {
  const url = `${registry.replace(/\/$/, '')}/${name.startsWith('@') ? name.replace('/', '%2F') : name}/${version}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`registry returned ${response.status} for ${url}`);
  }
  return response.json();
}

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};

async function main() {
  const version = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : PKG.version;
  const registry = arg('--registry', PKG.publishConfig?.registry ?? 'https://registry.npmjs.org/');
  const retries = Number(arg('--retries', 5));
  const waitMs = Number(arg('--wait-ms', 3000));

  let problems = ['not fetched'];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      problems = inspectRegistryDoc(await fetchRegistryDoc(registry, PKG.name, version), { name: PKG.name, version });
    } catch (error) {
      problems = [String(error instanceof Error ? error.message : error)];
    }
    if (!problems.length) {
      console.log(`Provenance OK for ${PKG.name}@${version}: SLSA attestation + gitHead + sha512 integrity`);
      return;
    }
    if (attempt < retries) {
      console.log(`Attempt ${attempt}/${retries}: ${problems[0]} — retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  console.error(`Provenance verification FAILED for ${PKG.name}@${version}:\n  ` + problems.join('\n  '));
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
