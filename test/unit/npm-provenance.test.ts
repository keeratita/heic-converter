import { describe, expect, it } from 'vitest';
import { inspectRegistryDoc, inspectAttestationDoc } from '../../build-scripts/verify-npm-provenance.mjs';

// The publish workflow must not be able to ship a package that quietly lost its
// attestation: a manual publish, a missing id-token permission, or a registry
// hiccup all produce an installable, unattributable tarball. dist.attestations
// is only a hint npm writes, so the statement it points at is what gets checked.

const NAME = '@keeratita/heic-converter';
const VERSION = '0.5.0';
const GHA_BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';

/** Registry shape with the two fields the gate requires marked optional, so
 *  the tests can delete them to prove each one is actually checked. */
const healthyRegistryDoc = (): {
  gitHead?: string;
  dist: { tarball: string; attestations?: { url: string; provenance: { predicateType: string } } };
} => ({
  gitHead: '718fef1773eae62c13885fc6a6fba3a550060763',
  dist: {
    tarball: 'https://registry.npmjs.org/@keeratita/heic-converter/-/heic-converter-0.5.0.tgz',
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@keeratita%2fheic-converter@0.5.0',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' }
    }
  }
});

function slsaAttestation({
  subject = `pkg:npm/%40keeratita/heic-converter@${VERSION}`,
  buildType = GHA_BUILD_TYPE,
  payload
}: { subject?: string; buildType?: string; payload?: string } = {}) {
  const encoded =
    payload ??
    Buffer.from(
      JSON.stringify({
        _type: 'https://in-toto.io/Statement/v1',
        subject: [{ name: subject, digest: { sha512: '47216e3d08cf777f' } }],
        predicate: { buildDefinition: { buildType } }
      })
    ).toString('base64');
  return { attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: encoded } } }] };
}

describe('inspectRegistryDoc', () => {
  it('accepts a version record with an attestation hint, a registry tarball and gitHead', () => {
    expect(inspectRegistryDoc(healthyRegistryDoc(), { name: NAME, version: VERSION })).toEqual([]);
  });

  it('rejects a version published without provenance', () => {
    const doc = healthyRegistryDoc();
    delete doc.dist.attestations;
    expect(inspectRegistryDoc(doc, { name: NAME, version: VERSION })).toContain(
      'dist.attestations.url is missing — the package was not published with provenance'
    );
  });

  it('rejects a tarball served from anywhere but the pinned registry', () => {
    // publishConfig.registry is honoured by `npm publish` too, so a commit that
    // repoints it must not be able to make this gate read a friendly host.
    const doc = healthyRegistryDoc();
    doc.dist.tarball = 'https://attacker.invalid/@keeratita/heic-converter/-/heic-converter-0.5.0.tgz';
    const problems = inspectRegistryDoc(doc, { name: NAME, version: VERSION });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('expected it to be served from https://registry.npmjs.org/');
  });

  it('rejects a tarball that cannot be traced back to a commit', () => {
    const doc = healthyRegistryDoc();
    delete doc.gitHead;
    expect(inspectRegistryDoc(doc, { name: NAME, version: VERSION })[0]).toContain('gitHead');
  });

  it('reports the package identity when the registry has no document at all', () => {
    expect(inspectRegistryDoc(null, { name: NAME, version: '9.9.9' })).toEqual([`no registry document for ${NAME}@9.9.9`]);
  });
});

describe('inspectAttestationDoc', () => {
  it('accepts a GitHub Actions SLSA statement naming this package at this version', () => {
    expect(inspectAttestationDoc(slsaAttestation(), { name: NAME, version: VERSION })).toEqual([]);
  });

  it('rejects a document carrying only the npm publish attestation', () => {
    // This is what "published but not from CI" looks like: no SLSA statement at all.
    const onlyPublish = {
      attestations: [{ predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} }]
    };
    const problems = inspectAttestationDoc(onlyPublish, { name: NAME, version: VERSION });
    expect(problems[0]).toContain('holds no https://slsa.dev/provenance statement');
  });

  it('rejects a document with no attestations array', () => {
    expect(inspectAttestationDoc({}, { name: NAME, version: VERSION })[0]).toContain('nothing');
    expect(inspectAttestationDoc(undefined, { name: NAME, version: VERSION })[0]).toContain('nothing');
  });

  it('rejects an attestation that describes a different package or version', () => {
    for (const subject of ['pkg:npm/%40someone/else@0.5.0', `pkg:npm/%40keeratita/heic-converter@0.4.2`]) {
      const problems = inspectAttestationDoc(slsaAttestation({ subject }), { name: NAME, version: VERSION });
      expect(problems[0]).toContain(`no attestation statement names pkg:npm/${NAME}@${VERSION}`);
    }
  });

  it('rejects a statement whose build type is not GitHub Actions', () => {
    // A laptop publish cannot produce the GitHub Actions build type, which is the
    // whole reason the statement is read instead of trusting the registry hint.
    const problems = inspectAttestationDoc(slsaAttestation({ buildType: 'https://example.invalid/local-build/v1' }), {
      name: NAME,
      version: VERSION
    });
    expect(problems[0]).toContain('not GitHub Actions');
  });

  it('rejects an undecodable statement rather than waving it through', () => {
    const broken = {
      attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: 'not base64 json' } } }]
    };
    expect(inspectAttestationDoc(broken, { name: NAME, version: VERSION })[0]).toContain(
      `no attestation statement names pkg:npm/${NAME}@${VERSION}`
    );
  });

  it('accepts the statement when a sibling attestation is the unusable one', () => {
    const doc = slsaAttestation();
    doc.attestations.unshift({ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: 'garbage' } } });
    expect(inspectAttestationDoc(doc, { name: NAME, version: VERSION })).toEqual([]);
  });
});
