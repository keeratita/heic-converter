#!/usr/bin/env node
// Publish gate (ESM). Run via `npm run verify:provenance [version]`.
//
// Publishing goes through .github/workflows/publish.yml, which gets an npm
// attestation from OIDC trusted publishing. That attestation is what lets
// consumers (and scanners such as Socket) tie the tarball to this repository's
// CI — but it fails *silently*: a manual `npm publish` from a laptop, a missing
// `id-token: write` permission, or a registry hiccup all produce a perfectly
// installable package with no provenance at all.
//
// `dist.attestations` on the version document is only a *hint* that npm writes,
// so the gate reads the attestation it points at and checks the statement
// itself: right package and version, SLSA provenance, and a GitHub Actions build
// type — which is what a laptop publish cannot produce. The registry URL is
// hardcoded: honouring publishConfig.registry would let a commit point both
// `npm publish` and this check at a host that will say anything.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REGISTRY = 'https://registry.npmjs.org/';
const SLSA_PREDICATE = 'https://slsa.dev/provenance';
const GITHUB_ACTIONS_BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/';
const ATTEMPTS = 10;
const WAIT_MS = 3000;
const MAX_WAIT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Checks the registry's version document: attestation hint, tarball host, commit link. */
export function inspectRegistryDoc(doc, { name = PKG.name, version = PKG.version } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object') {
    return [`no registry document for ${name}@${version}`];
  }
  if (!doc.dist?.attestations?.url) {
    problems.push('dist.attestations.url is missing — the package was not published with provenance');
  }
  const tarball = String(doc.dist?.tarball ?? '');
  if (!tarball.startsWith(REGISTRY)) {
    problems.push(`dist.tarball is ${JSON.stringify(tarball)}, expected it to be served from ${REGISTRY}`);
  }
  if (!doc.gitHead) {
    problems.push('gitHead is missing — the tarball cannot be traced back to a commit');
  }
  return problems;
}

/**
 * Checks the signed statement the hint points at, so an unrelated or stale
 * attestation cannot satisfy the gate: subject must be this package at this
 * version, and the build type must be the GitHub Actions one.
 */
export function inspectAttestationDoc(attestations, { name = PKG.name, version = PKG.version } = {}) {
  const entries = Array.isArray(attestations?.attestations) ? attestations.attestations : [];
  const slsa = entries.filter((entry) => String(entry?.predicateType ?? '').startsWith(SLSA_PREDICATE));
  if (!slsa.length) {
    return [`the attestation document holds no ${SLSA_PREDICATE} statement (found: ${entries.map((e) => e?.predicateType).join(', ') || 'nothing'})`];
  }
  for (const entry of slsa) {
    let statement;
    try {
      statement = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    } catch {
      continue; // undecodable bundle: try the next statement before calling it a failure
    }
    const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
    const named = subjects.some((subject) => String(subject?.name ?? '').replace('%40', '@') === `pkg:npm/${name}@${version}`);
    if (!named) {
      continue;
    }
    const buildType = String(statement.predicate?.buildDefinition?.buildType ?? '');
    if (!buildType.startsWith(GITHUB_ACTIONS_BUILD_TYPE)) {
      return [`attestation for ${name}@${version} was produced by build type ${JSON.stringify(buildType)}, not GitHub Actions`];
    }
    return [];
  }
  return [`no attestation statement names pkg:npm/${name}@${version}`];
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`registry returned ${response.status} for ${url}`);
  }
  return response.json();
}

function versionFromArgs() {
  const arg = process.argv[2];
  return arg && !arg.startsWith('-') ? arg : PKG.version;
}

async function main() {
  const version = versionFromArgs();
  const base = REGISTRY.replace(/\/$/, '');
  const encoded = PKG.name.startsWith('@') ? PKG.name.replace('/', '%2F') : PKG.name;
  let problems = ['not fetched'];

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const doc = await fetchJson(`${base}/${encoded}/${version}`);
      problems = inspectRegistryDoc(doc, { name: PKG.name, version });
      if (!problems.length) {
        const attestationUrl = doc.dist.attestations.url;
        problems = inspectAttestationDoc(await fetchJson(attestationUrl), { name: PKG.name, version });
      }
    } catch (error) {
      problems = [String(error instanceof Error ? error.message : error)];
    }
    if (!problems.length) {
      console.log(`Provenance OK for ${PKG.name}@${version}: GitHub Actions SLSA statement + gitHead + registry-hosted tarball`);
      return;
    }
    if (attempt < ATTEMPTS) {
      // Growing waits, capped: a just-published version can 404 on the
      // registry's version endpoint for a minute while it propagates, and a
      // false red here is unrecoverable — npm refuses a re-publish of the same
      // version, so the job cannot simply be retried. Every problem (a lagging
      // read *and* a validation mismatch) therefore gets the full window; a
      // slow red is acceptable, a wrong one is not. The whole loop stays well
      // inside the publish job's 15 minute timeout even if every request hangs.
      const waitMs = Math.min(WAIT_MS * 2 ** (attempt - 1), MAX_WAIT_MS);
      console.log(`Attempt ${attempt}/${ATTEMPTS}: ${problems[0]} — retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  console.error(`Provenance verification FAILED for ${PKG.name}@${version}:\n  ` + problems.join('\n  '));
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
