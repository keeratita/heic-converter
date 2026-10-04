import { describe, expect, it } from 'vitest';
import { inspectRegistryDoc } from '../../build-scripts/verify-npm-provenance.mjs';

// The publish workflow must not be able to ship a package that quietly lost its
// attestation: a manual publish, a missing id-token permission, or a registry
// hiccup all produce an installable, unattributable tarball.

const healthy = () => ({
  gitHead: '718fef1773eae62c13885fc6a6fba3a550060763',
  dist: {
    integrity: 'sha512-RyFuPQjPd3/IG4BjaRdTRe7I+HsKNYP9591o9Uxb4/Q7tEwbb4AUfWGzRoAVyyHyt+zQevr/jmHYTNE7PJIRSg==',
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@keeratita%2fheic-converter@0.5.0',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' }
    }
  }
});

describe('inspectRegistryDoc', () => {
  it('accepts a published version with provenance, gitHead and sha512 integrity', () => {
    expect(inspectRegistryDoc(healthy())).toEqual([]);
  });

  it('rejects a version published without provenance', () => {
    const doc = healthy();
    delete doc.dist.attestations;
    const problems = inspectRegistryDoc(doc);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not published with provenance');
  });

  it('rejects an attestation that is not a SLSA provenance statement', () => {
    const doc = healthy();
    doc.dist.attestations.provenance.predicateType = 'https://example.invalid/attestation/v1';
    const problems = inspectRegistryDoc(doc);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('predicateType');
  });

  it('rejects a tarball that cannot be tied back to a commit', () => {
    const doc = healthy();
    delete doc.gitHead;
    const problems = inspectRegistryDoc(doc);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('gitHead');
  });

  it('rejects a missing or weak integrity hash', () => {
    const weak = healthy();
    weak.dist.integrity = 'sha1-abcdef=';
    expect(inspectRegistryDoc(weak)[0]).toContain('sha512');

    const missing = healthy();
    delete missing.dist.integrity;
    expect(inspectRegistryDoc(missing)[0]).toContain('sha512');
  });

  it('reports the package identity when the registry has no document at all', () => {
    const problems = inspectRegistryDoc(null, { name: '@keeratita/heic-converter', version: '9.9.9' });
    expect(problems).toEqual(['no registry document for @keeratita/heic-converter@9.9.9']);
  });
});
