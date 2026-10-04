import { describe, expect, it } from 'vitest';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { verifySidecars } from '../../build-scripts/compress-wasm.mjs';

// `npm run build` refuses to ship sidecars that do not decompress: a CDN with
// gzip_static/brotli_static serves those bytes verbatim, so a corrupt one
// breaks decoding only for visitors that get the precompressed response —
// invisible to the E2E suite, which fetches the raw binary.

const RAW = new Uint8Array(4096).fill(7);
const good = () => ({ gz: gzipSync(RAW), br: brotliCompressSync(RAW) });

describe('verifySidecars', () => {
  it('accepts sidecars that decompress back to the binary', () => {
    expect(verifySidecars(RAW, good())).toBeNull();
  });

  it('rejects a truncated gzip sidecar', () => {
    const sidecars = good();
    sidecars.gz = sidecars.gz.subarray(0, sidecars.gz.length - 500);
    expect(verifySidecars(RAW, sidecars)).toContain('gzip (.gz)');
  });

  it('rejects a truncated brotli sidecar', () => {
    const sidecars = good();
    sidecars.br = sidecars.br.subarray(0, sidecars.br.length - 50);
    expect(verifySidecars(RAW, sidecars)).toContain('brotli (.br)');
  });

  it('rejects a sidecar that decompresses to the wrong bytes', () => {
    // Well-formed compression of different content is the dangerous case: it
    // decompresses cleanly, so only the byte comparison can catch it.
    expect(verifySidecars(RAW, { gz: gzipSync(new Uint8Array(4096).fill(8)), br: good().br })).toContain(
      'not the 4096-byte heic-decoder.wasm'
    );
  });

  it('rejects a brotli payload in the gzip slot rather than accepting it silently', () => {
    const sidecars = good();
    sidecars.gz = sidecars.br;
    expect(verifySidecars(RAW, sidecars)).toContain('cannot be decompressed');
  });
});
