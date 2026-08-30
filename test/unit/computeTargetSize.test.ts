import { describe, it, expect } from 'vitest';
import { computeTargetSize, validateResize } from '../../src/render/canvas';

describe('computeTargetSize', () => {
  it('returns the original size when no resize options are given', () => {
    expect(computeTargetSize(200, 100)).toEqual({ width: 200, height: 100 });
  });

  it('returns the original size for an empty resize object', () => {
    expect(computeTargetSize(200, 100, {})).toEqual({ width: 200, height: 100 });
  });

  it('returns the original size for null resize', () => {
    expect(computeTargetSize(200, 100, null as any)).toEqual({ width: 200, height: 100 });
  });

  it('applies the scale factor', () => {
    expect(computeTargetSize(200, 100, { scale: 0.5 })).toEqual({ width: 100, height: 50 });
  });

  it('rounds scaled dimensions', () => {
    expect(computeTargetSize(200, 100, { scale: 0.33 })).toEqual({ width: 66, height: 33 });
  });

  it('never produces dimensions below 1 pixel', () => {
    expect(computeTargetSize(200, 100, { scale: 0.001 })).toEqual({ width: 1, height: 1 });
  });

  it('keeps a 1x1 image at 1x1 when downscaled', () => {
    expect(computeTargetSize(1, 1, { scale: 0.5 })).toEqual({ width: 1, height: 1 });
  });

  it('upscales with a scale factor greater than 1', () => {
    expect(computeTargetSize(10, 10, { scale: 2 })).toEqual({ width: 20, height: 20 });
  });

  it('lets scale take precedence over maxWidth and maxHeight', () => {
    expect(computeTargetSize(200, 100, { maxWidth: 50, maxHeight: 50, scale: 0.5 })).toEqual({
      width: 100,
      height: 50,
    });
  });

  it('downscales to fit within maxWidth', () => {
    expect(computeTargetSize(200, 100, { maxWidth: 100 })).toEqual({ width: 100, height: 50 });
  });

  it('downscales to fit within maxHeight', () => {
    expect(computeTargetSize(200, 100, { maxHeight: 50 })).toEqual({ width: 100, height: 50 });
  });

  it('uses the most restrictive of maxWidth and maxHeight', () => {
    expect(computeTargetSize(200, 100, { maxWidth: 100, maxHeight: 40 })).toEqual({
      width: 80,
      height: 40,
    });
  });

  it('does not resize when maxWidth equals the image width', () => {
    expect(computeTargetSize(200, 100, { maxWidth: 200 })).toEqual({ width: 200, height: 100 });
  });

  it('does not upscale when maxWidth is larger than the image', () => {
    expect(computeTargetSize(200, 100, { maxWidth: 1000 })).toEqual({ width: 200, height: 100 });
  });

  it('rounds maxWidth downscale dimensions', () => {
    expect(computeTargetSize(200, 100, { maxWidth: 99 })).toEqual({ width: 99, height: 50 });
  });

  it('handles extreme aspect ratios (very wide)', () => {
    expect(computeTargetSize(10000, 10, { maxWidth: 100 })).toEqual({ width: 100, height: 1 });
  });

  it('handles extreme aspect ratios (very tall)', () => {
    expect(computeTargetSize(10, 10000, { maxHeight: 100 })).toEqual({ width: 1, height: 100 });
  });

  it('keeps a 1-pixel dimension when downscaling extreme ratios', () => {
    expect(computeTargetSize(10000, 1, { maxWidth: 100 })).toEqual({ width: 100, height: 1 });
  });

  it('never exceeds fractional maxWidth and maxHeight bounds', () => {
    expect(computeTargetSize(1000, 1000, { maxWidth: 999.6, maxHeight: 999.5 })).toEqual({
      width: 999,
      height: 999,
    });
  });

  it('throws when scale produces a dimension above the canvas cap', () => {
    expect(() => computeTargetSize(1000, 1000, { scale: 100 })).toThrow(
      'Target image size 100000x100000 exceeds the maximum supported dimension of 16384px'
    );
  });

  it('throws when scale produces non-finite dimensions', () => {
    expect(() => computeTargetSize(1000, 1000, { scale: 1e308 })).toThrow(
      'Target image size InfinityxInfinity exceeds the maximum supported dimension of 16384px'
    );
  });

  it('allows dimensions up to the canvas cap', () => {
    expect(computeTargetSize(16384, 16384, { scale: 1 })).toEqual({
      width: 16384,
      height: 16384,
    });
  });
});

describe('validateResize', () => {
  it('does not throw for undefined', () => {
    expect(() => validateResize()).not.toThrow();
  });

  it('does not throw for null', () => {
    expect(() => validateResize(null as any)).not.toThrow();
  });

  it('does not throw for an empty object', () => {
    expect(() => validateResize({})).not.toThrow();
  });

  it('does not throw for valid options', () => {
    expect(() => validateResize({ maxWidth: 800, maxHeight: 600, scale: 0.5 })).not.toThrow();
  });

  it('throws for scale as a string', () => {
    expect(() => validateResize({ scale: '0.5' as any })).toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('throws for scale as a boolean', () => {
    expect(() => validateResize({ scale: true as any })).toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('throws for maxWidth as a string', () => {
    expect(() => validateResize({ maxWidth: '800' as any })).toThrow(
      'maxWidth must be a positive finite number'
    );
  });

  it('throws for maxHeight as a boolean', () => {
    expect(() => validateResize({ maxHeight: false as any })).toThrow(
      'maxHeight must be a positive finite number'
    );
  });
});
