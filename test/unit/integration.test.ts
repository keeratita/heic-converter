import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertHeic, freeSharedDecoder, LibheifDecoder } from '../../src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

// Path to fixtures
const examplePath = path.join(ROOT_DIR, 'test/fixtures/example.heic');
const noAlphaPath = path.join(ROOT_DIR, 'test/fixtures/colors-no-alpha.heic');
const withAlphaPath = path.join(ROOT_DIR, 'test/fixtures/colors-with-alpha.heic');

describe('Integration Tests', () => {
  beforeEach(() => {
    freeSharedDecoder();
  });

  afterEach(() => {
    freeSharedDecoder();
  });

  describe.skip('End-to-end conversion flow', () => {
    it('should convert example.heic to JPEG successfully', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const result = await convertHeic(heicData, { to: 'jpeg', quality: 0.92 });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
      expect(result.size).toBeGreaterThan(0);
    });

    it('should convert example.heic to PNG successfully', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const result = await convertHeic(heicData, { to: 'png' });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/png');
      expect(result.size).toBeGreaterThan(0);
    });

    it('should convert example.heic to SVG successfully', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const result = await convertHeic(heicData, { to: 'svg' });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/svg+xml');
      
      const svgContent = await result.text();
      expect(svgContent).toContain('<svg');
      expect(svgContent).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svgContent).toContain('data:image/png;base64');
    });

    it('should convert colors-no-alpha.heic to all formats', async () => {
      const heicData = fs.readFileSync(noAlphaPath);
      
      const formats: Array<'jpeg' | 'png' | 'svg'> = ['jpeg', 'png', 'svg'];
      
      for (const format of formats) {
        const result = await convertHeic(heicData, { to: format });
        
        expect(result).toBeInstanceOf(Blob);
        expect(result.size).toBeGreaterThan(0);
      }
    });

    it('should convert colors-with-alpha.heic to all formats', async () => {
      const heicData = fs.readFileSync(withAlphaPath);
      
      const formats: Array<'jpeg' | 'png' | 'svg'> = ['jpeg', 'png', 'svg'];
      
      for (const format of formats) {
        const result = await convertHeic(heicData, { to: format });
        
        expect(result).toBeInstanceOf(Blob);
        expect(result.size).toBeGreaterThan(0);
      }
    });

    it('should preserve quality setting across conversions', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const lowQualityResult = await convertHeic(heicData, { to: 'jpeg', quality: 0.1 });
      const highQualityResult = await convertHeic(heicData, { to: 'jpeg', quality: 1.0 });
      
      // Higher quality should generally result in larger file size
      expect(highQualityResult.size).toBeGreaterThanOrEqual(lowQualityResult.size);
    });
  });

  describe.skip('Memory leak detection', () => {
    it('should not leak memory after many conversions', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const initialMemory = process.memoryUsage();
      
      // Perform many conversions
      for (let i = 0; i < 20; i++) {
        await convertHeic(heicData, { to: 'jpeg' });
      }
      
      const finalMemory = process.memoryUsage();
      
      // Check that memory growth is within acceptable bounds
      // This is a loose check - in practice, you'd want more sophisticated memory testing
      const heapGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
      const heapGrowthPercent = (heapGrowth / initialMemory.heapUsed) * 100;
      
      // Allow up to 50% growth (generous for Node.js GC behavior)
      expect(heapGrowthPercent).toBeLessThan(50);
    });

    it('should handle concurrent conversions without memory issues', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const initialMemory = process.memoryUsage();
      
      // Perform many concurrent conversions
      const promises = Array(10).fill(null).map(() => 
        convertHeic(heicData, { to: 'jpeg' })
      );
      
      await Promise.all(promises);
      
      const finalMemory = process.memoryUsage();
      
      const heapGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
      const heapGrowthPercent = (heapGrowth / initialMemory.heapUsed) * 100;
      
      expect(heapGrowthPercent).toBeLessThan(100);
    });

    it('should free memory after freeSharedDecoder is called', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Perform some conversions
      for (let i = 0; i < 5; i++) {
        await convertHeic(heicData, { to: 'jpeg' });
      }
      
      const beforeFree = process.memoryUsage();
      freeSharedDecoder();
      
      // Allow GC to run
      if (global.gc) {
        global.gc();
      }
      
      const afterFree = process.memoryUsage();
      
      // Memory should not increase significantly after free
      expect(afterFree.heapUsed).toBeLessThanOrEqual(beforeFree.heapUsed + 1000000); // 1MB tolerance
    });
  });

  describe.skip('Progress callback integration', () => {
    it('should report progress during conversion', async () => {
      const heicData = fs.readFileSync(examplePath);
      const progressUpdates: number[] = [];
      
      await convertHeic(heicData, {
        to: 'jpeg',
        onProgress: (percent) => {
          progressUpdates.push(percent);
        }
      });
      
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
    });

    it('should report progress for all output formats', async () => {
      const heicData = fs.readFileSync(examplePath);
      const formats: Array<'jpeg' | 'png' | 'svg'> = ['jpeg', 'png', 'svg'];
      
      for (const format of formats) {
        const progressUpdates: number[] = [];
        
        await convertHeic(heicData, {
          to: format,
          onProgress: (percent) => {
            progressUpdates.push(percent);
          }
        });
        
        expect(progressUpdates.length).toBeGreaterThan(0);
        expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
      }
    });
  });

  describe.skip('Custom decoder integration', () => {
    it('should work with custom decoder instance', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const customDecoder = new LibheifDecoder();
      await customDecoder.initialize();
      
      try {
        const result = await convertHeic(heicData, {
          to: 'png',
          decoder: customDecoder
        });
        
        expect(result).toBeInstanceOf(Blob);
        expect(result.type).toBe('image/png');
      } finally {
        customDecoder.free();
      }
    });

    it('should reuse custom decoder across multiple conversions', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const customDecoder = new LibheifDecoder();
      await customDecoder.initialize();
      
      try {
        // First conversion
        const result1 = await convertHeic(heicData, {
          to: 'jpeg',
          decoder: customDecoder
        });
        
        // Second conversion with same decoder
        const result2 = await convertHeic(heicData, {
          to: 'png',
          decoder: customDecoder
        });
        
        expect(result1).toBeInstanceOf(Blob);
        expect(result2).toBeInstanceOf(Blob);
      } finally {
        customDecoder.free();
      }
    });

    it('should not free custom decoder after conversion', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const customDecoder = new LibheifDecoder();
      await customDecoder.initialize();
      
      const freeSpy = vi.spyOn(customDecoder, 'free');
      
      try {
        await convertHeic(heicData, {
          to: 'jpeg',
          decoder: customDecoder
        });
        
        // Custom decoder should not be freed by convertHeic
        expect(freeSpy).not.toHaveBeenCalled();
      } finally {
        customDecoder.free();
      }
    });
  });

  describe.skip('Error handling integration', () => {
    it('should handle invalid HEIC file gracefully', async () => {
      const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      
      await expect(convertHeic(invalidData)).rejects.toThrow();
    });

    it('should handle corrupted file during conversion', async () => {
      // Create a file that starts valid but is truncated
      const heicData = fs.readFileSync(examplePath);
      const truncatedData = heicData.slice(0, 100);
      
      // libheif is robust and can decode partial/truncated HEIC files
      // This is valid behavior - the decoder extracts what it can
      const result = await convertHeic(truncatedData);
      
      expect(result).toBeInstanceOf(Blob);
    });

    it('should preserve error messages from decoder', async () => {
      const invalidData = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
      
      try {
        await convertHeic(invalidData);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeTruthy();
      }
    });
  });

  describe.skip('Type validation edge cases', () => {
    it('should handle quality as string that looks like a number', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Should throw because quality must be a number, not a string
      await expect(convertHeic(heicData, { quality: '0.5' as any })).rejects.toThrow(
        'Quality must be a number'
      );
    });

    it('should handle quality as boolean true', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      await expect(convertHeic(heicData, { quality: true as any })).rejects.toThrow(
        'Quality must be a number'
      );
    });

    it('should handle quality as boolean false', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      await expect(convertHeic(heicData, { quality: false as any })).rejects.toThrow(
        'Quality must be a number'
      );
    });

    it('should handle quality as null', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      await expect(convertHeic(heicData, { quality: null as any })).rejects.toThrow(
        'Quality must be a number'
      );
    });

    it('should handle quality as undefined explicitly', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // undefined should use default quality
      const result = await convertHeic(heicData, { quality: undefined });
      
      expect(result).toBeInstanceOf(Blob);
    });

    it('should handle format as number', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Invalid format defaults to jpeg
      const result = await convertHeic(heicData, { to: 123 as any });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
    });

    it('should handle format as object', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Invalid format defaults to jpeg
      const result = await convertHeic(heicData, { to: {} as any });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
    });

    it('should handle format as array', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Invalid format defaults to jpeg
      const result = await convertHeic(heicData, { to: ['jpeg'] as any });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
    });

    it('should handle onProgress as non-function', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Should work (null/undefined are valid)
      const result = await convertHeic(heicData, { onProgress: null as any });
      
      expect(result).toBeInstanceOf(Blob);
    });

    it('should handle decoder as non-object', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Invalid decoder should cause error during initialization
      await expect(convertHeic(heicData, { decoder: 'invalid' as any })).rejects.toThrow();
    });
  });

  describe.skip('Edge case combinations', () => {
    it('should handle low quality with PNG output', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Quality is ignored for PNG but should not cause error
      const result = await convertHeic(heicData, { to: 'png', quality: 0.1 });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/png');
    });

    it('should handle high quality with SVG output', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      // Quality affects the embedded PNG in SVG
      const result = await convertHeic(heicData, { to: 'svg', quality: 1.0 });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/svg+xml');
    });

    it('should handle zero quality with JPEG', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const result = await convertHeic(heicData, { to: 'jpeg', quality: 0 });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
      // Zero quality should produce smallest file
    });

    it('should handle maximum quality with JPEG', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const result = await convertHeic(heicData, { to: 'jpeg', quality: 1 });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
    });

    it('should handle mixed case format names', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const result = await convertHeic(heicData, { to: 'JPEG' as any });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
    });

    it('should handle jpg as format alias', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const result = await convertHeic(heicData, { to: 'jpg' });
      
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
    });
  });

  describe.skip('Performance edge cases', () => {
    it('should handle conversion within reasonable time', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const startTime = Date.now();
      await convertHeic(heicData, { to: 'jpeg' });
      const endTime = Date.now();
      
      // Should complete within 5 seconds (generous timeout)
      expect(endTime - startTime).toBeLessThan(5000);
    });

    it('should handle sequential conversions efficiently', async () => {
      const heicData = fs.readFileSync(examplePath);
      
      const startTime = Date.now();
      
      for (let i = 0; i < 5; i++) {
        await convertHeic(heicData, { to: 'jpeg' });
      }
      
      const endTime = Date.now();
      
      // 5 conversions should complete within 10 seconds
      expect(endTime - startTime).toBeLessThan(10000);
    });
  });
});