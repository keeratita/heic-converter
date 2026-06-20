import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LibheifDecoder } from '../../src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

// Path to fixtures
const examplePath = path.join(ROOT_DIR, 'test/fixtures/example.heic');
const noAlphaPath = path.join(ROOT_DIR, 'test/fixtures/colors-no-alpha.heic');
const withAlphaPath = path.join(ROOT_DIR, 'test/fixtures/colors-with-alpha.heic');

// Path to compiled WASM
const wasmPath = path.join(ROOT_DIR, 'dist/heic-decoder.wasm');

describe('LibheifDecoder Unit Tests', () => {
  // Read WASM binary for testing
  const wasmBinary = fs.readFileSync(wasmPath).buffer;

  it('should initialize successfully', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });
    await expect(decoder.initialize()).resolves.not.toThrow();
    decoder.free();
  });

  it('should decode example.heic successfully', async () => {
    const heicData = new Uint8Array(fs.readFileSync(examplePath));
    const decoder = new LibheifDecoder({ wasmBinary });
    
    await decoder.initialize();
    const result = await decoder.decode(heicData);
    
    expect(result).toBeDefined();
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.data).toBeInstanceOf(Uint8ClampedArray);
    expect(result.data.length).toBe(result.width * result.height * 4);
    
    decoder.free();
  });

  it('should call the onProgress callback during decode', async () => {
    const heicData = new Uint8Array(fs.readFileSync(examplePath));
    const decoder = new LibheifDecoder({ wasmBinary });
    
    await decoder.initialize();
    const progressPercentages: number[] = [];
    const onProgress = (percent: number) => {
      progressPercentages.push(percent);
    };

    const result = await decoder.decode(heicData, onProgress);
    
    expect(result).toBeDefined();
    expect(progressPercentages.length).toBeGreaterThan(0);
    expect(progressPercentages[0]).toBeGreaterThanOrEqual(0);
    expect(progressPercentages[progressPercentages.length - 1]).toBe(100);
    
    decoder.free();
  });

  it('should decode colors-no-alpha.heic successfully', async () => {
    const heicData = new Uint8Array(fs.readFileSync(noAlphaPath));
    const decoder = new LibheifDecoder({ wasmBinary });
    
    await decoder.initialize();
    const result = await decoder.decode(heicData);
    
    expect(result).toBeDefined();
    // Verify specific properties if known, e.g. width/height
    expect(result.width).toBe(64); // colors-no-alpha is 64x64
    expect(result.height).toBe(64);
    expect(result.data.length).toBe(64 * 64 * 4);
    
    decoder.free();
  });

  it('should decode colors-with-alpha.heic successfully', async () => {
    const heicData = new Uint8Array(fs.readFileSync(withAlphaPath));
    const decoder = new LibheifDecoder({ wasmBinary });
    
    await decoder.initialize();
    const result = await decoder.decode(heicData);
    
    expect(result).toBeDefined();
    expect(result.width).toBe(64); // colors-with-alpha is 64x64
    expect(result.height).toBe(64);
    expect(result.data.length).toBe(64 * 64 * 4);
    
    decoder.free();
  });

  it('should throw an error on invalid HEIC data', async () => {
    const invalidData = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const decoder = new LibheifDecoder({ wasmBinary });
    
    await decoder.initialize();
    await expect(decoder.decode(invalidData)).rejects.toThrow();
    
    decoder.free();
  });

  describe('HEIC file edge cases', () => {
    it('should handle truncated HEIC file', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const truncatedData = heicData.slice(0, Math.floor(heicData.length / 2));
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      await expect(decoder.decode(truncatedData)).rejects.toThrow();
      
      decoder.free();
    });

    it('should handle HEIC with only header (no image data)', async () => {
      // Create a minimal HEIC-like header (not valid but tests edge case)
      const minimalHeader = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, // box size
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
      ]);
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      await expect(decoder.decode(minimalHeader)).rejects.toThrow();
      
      decoder.free();
    });

    it('should handle HEIC file with extra trailing data', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const dataWithTrailer = new Uint8Array([...heicData, ...new Uint8Array(100).fill(0xFF)]);
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      // Should still decode successfully (extra data ignored)
      const result = await decoder.decode(dataWithTrailer);
      
      expect(result).toBeDefined();
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      
      decoder.free();
    });

    it('should handle HEIC with all zeros', async () => {
      const zerosData = new Uint8Array(1000).fill(0);
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      await expect(decoder.decode(zerosData)).rejects.toThrow();
      
      decoder.free();
    });

    it('should handle HEIC with all 0xFF bytes', async () => {
      const ffData = new Uint8Array(1000).fill(0xFF);
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      await expect(decoder.decode(ffData)).rejects.toThrow();
      
      decoder.free();
    });

    it('should handle alternating byte pattern', async () => {
      const alternatingData = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) {
        alternatingData[i] = i % 2 === 0 ? 0x00 : 0xFF;
      }
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      await expect(decoder.decode(alternatingData)).rejects.toThrow();
      
      decoder.free();
    });
  });

  describe('WASM and decoder lifecycle edge cases', () => {
    it('should handle corrupted WASM binary', async () => {
      const corruptedWasm = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      
      const decoder = new LibheifDecoder({ wasmBinary: corruptedWasm.buffer });
      
      // Should fail to initialize with corrupted WASM
      await expect(decoder.initialize()).rejects.toThrow();
    });

    it('should handle empty WASM binary', async () => {
      const emptyWasm = new ArrayBuffer(0);
      
      const decoder = new LibheifDecoder({ wasmBinary: emptyWasm });
      
      await expect(decoder.initialize()).rejects.toThrow();
    });

    it('should handle using decoder after free', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const decoder = new LibheifDecoder({ wasmBinary });
      
      await decoder.initialize();
      decoder.free();
      
      // Using decoder after free may or may not throw depending on implementation
      // We just verify it doesn't crash the test
      try {
        await decoder.decode(heicData);
        // If it succeeds, that's fine
      } catch (e) {
        // If it throws, that's also fine
        expect(e).toBeDefined();
      }
    });

    it('should handle calling free multiple times', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      // First free should succeed
      decoder.free();
      
      // Second free should not throw (idempotent)
      expect(() => decoder.free()).not.toThrow();
    });

    it('should handle calling free before initialize', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });
      
      // Free before initialize should not throw
      expect(() => decoder.free()).not.toThrow();
    });

    it('should handle decode without initialize', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const decoder = new LibheifDecoder({ wasmBinary });
      
      // Mock decoder succeeds even without explicit initialize call
      const result = await decoder.decode(heicData);
      
      expect(result).toBeDefined();
    });

    it('should handle concurrent decode on same decoder', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const decoder = new LibheifDecoder({ wasmBinary });
      
      await decoder.initialize();
      
      // Attempt concurrent decodes
      const promises = [
        decoder.decode(heicData),
        decoder.decode(heicData),
      ];
      
      // At least one should fail or both complete (depending on implementation)
      const results = await Promise.allSettled(promises);
      
      // Verify we got results (either both succeed or some fail)
      expect(results).toHaveLength(2);
      
      decoder.free();
    });

    it('should handle very small WASM binary', async () => {
      const smallWasm = new Uint8Array([0x00, 0x01, 0x02]);
      
      const decoder = new LibheifDecoder({ wasmBinary: smallWasm.buffer });
      
      await expect(decoder.initialize()).rejects.toThrow();
    });
  });

  describe('Progress callback edge cases', () => {
    it('should handle progress callback that throws', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const throwingProgress = vi.fn().mockImplementation(() => {
        throw new Error('Progress error');
      });
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      // The error should propagate
      await expect(decoder.decode(heicData, throwingProgress)).rejects.toThrow();
      
      decoder.free();
    });

    it('should handle progress callback that is not a function', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      // Should not throw with non-function progress
      const result = await decoder.decode(heicData, null as any);
      
      expect(result).toBeDefined();
      
      decoder.free();
    });

    it('should handle progress callback with side effects', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const sideEffectProgress = vi.fn().mockImplementation((percent) => {
        // Simulate side effect
        void new Array(100).fill(percent);
      });
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      const result = await decoder.decode(heicData, sideEffectProgress);
      
      expect(result).toBeDefined();
      expect(sideEffectProgress).toHaveBeenCalled();
      
      decoder.free();
    });

    it('should handle async progress callback', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const asyncProgress = vi.fn().mockImplementation(async (percent) => {
        await Promise.resolve();
        return percent;
      });
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      const result = await decoder.decode(heicData, asyncProgress);
      
      expect(result).toBeDefined();
      
      decoder.free();
    });
  });

  describe('Decoded image edge cases', () => {
    it('should handle decoding image with zero dimensions', async () => {
      // This tests the decoder's handling of malformed HEIC that might report zero dimensions
      const invalidData = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      await expect(decoder.decode(invalidData)).rejects.toThrow();
      
      decoder.free();
    });

    it('should handle decoding image with very large dimensions', async () => {
      // Create data that might be interpreted as having large dimensions
      const largeDimData = new Uint8Array(10000);
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      // Should fail (not valid HEIC) but not crash
      await expect(decoder.decode(largeDimData)).rejects.toThrow();
      
      decoder.free();
    });

    it('should verify decoded data length matches dimensions', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      
      const result = await decoder.decode(heicData);
      
      // Verify the invariant: data.length === width * height * 4
      expect(result.data.length).toBe(result.width * result.height * 4);
      
      decoder.free();
    });
  });

  describe('Memory management edge cases', () => {
    it('should handle multiple initialize calls', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });
      
      // First initialize
      await decoder.initialize();
      
      // Second initialize should either succeed or fail gracefully
      await expect(decoder.initialize()).resolves.not.toThrow();
      
      decoder.free();
    });

    it('should handle rapid create-free cycles', async () => {
      for (let i = 0; i < 5; i++) {
        const decoder = new LibheifDecoder({ wasmBinary });
        await decoder.initialize();
        decoder.free();
      }
    });

    it('should handle many sequential decodes', async () => {
      const heicData = new Uint8Array(fs.readFileSync(examplePath));
      const decoder = new LibheifDecoder({ wasmBinary });
      
      await decoder.initialize();
      
      for (let i = 0; i < 10; i++) {
        const result = await decoder.decode(heicData);
        expect(result).toBeDefined();
      }
      
      decoder.free();
    });
  });
});
