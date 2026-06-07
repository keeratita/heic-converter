import { describe, it, expect } from 'vitest';
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
});
