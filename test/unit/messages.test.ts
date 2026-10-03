import { describe, expect, it } from 'vitest';
import { Messages } from '../../src/messages';

/**
 * Message builders are the single source of user-facing error text. These
 * tests pin the template contracts (including the optional-detail branches
 * of the worker diagnostics) so callers' message assertions stay stable.
 */
describe('Messages', () => {
  describe('index.ts builders', () => {
    it('formats the core validation messages', () => {
      expect(Messages.QualityInvalid(2)).toContain('Quality must be a number between 0.0 and 1.0, got: 2');
      expect(Messages.ApplyOrientationInvalid('yes')).toBe('applyOrientation must be a boolean, got: yes');
      expect(Messages.UnsupportedInputType('[object Object]')).toContain('Got: [object Object]');
      expect(Messages.DecoderInitFailed('boom')).toContain('Failed to initialize HEIC decoder: boom');
      expect(Messages.DecoderInitFailed('boom')).toContain('wasm-unsafe-eval');
      expect(Messages.RenderEncodeFailed('png', 'oops')).toContain('as png: oops');
      expect(Messages.ConcurrencyInvalid(0)).toContain('got: 0');
      expect(Messages.MaxConcurrentWorkersInvalid(1.5)).toContain(
        'maxConcurrentWorkers must be a positive integer, got: 1.5'
      );
      expect(Messages.TimeoutInvalid(-1)).toContain('timeoutMs must be a finite number >= 0');
      expect(Messages.InputsMustBeArray).toBe('Inputs must be an array of HEIC images');
      expect(Messages.ConvertManyItemFailed(2, 3, 'nope')).toBe(
        'Conversion of item 2 of 3 failed: nope'
      );
      expect(Messages.ConvertManyExtraFailures(4, 5)).toBe(' (4 of 5 items failed in total)');
      expect(Messages.ConvertManyOtherErrors(['a', 'b'])).toBe('; other errors: a | b');
      expect(Messages.BatchItemProducedNoResult(2)).toBe('Item 2 produced no result');
      expect(Messages.BatchItemProducedNoResult(undefined)).toBe('Item undefined produced no result');
      expect(Messages.BatchEndedWithoutResult).toBe('Batch ended without a result');
    });
  });

  describe('render/canvas.ts builders', () => {
    it('formats resize, canvas, and render messages', () => {
      expect(Messages.ScaleInvalid(0)).toContain('Scale must be a positive finite number, got: 0');
      expect(Messages.MaxWidthInvalid(-5)).toContain('maxWidth must be a positive finite number');
      expect(Messages.MaxHeightInvalid(Number.NaN)).toContain('maxHeight must be a positive finite number');
      expect(Messages.TargetSizeTooLarge(20000, 10, 16384)).toContain('16384');
      expect(Messages.BlobToBase64Failed).toContain('base64');
      expect(Messages.BlobToBase64FailedWithCause('io')).toContain('io');
      expect(Messages.CanvasToBlobFailed('image/png')).toContain('image/png');
      expect(Messages.CanvasUnsupported).toContain('Canvas is not supported');
      expect(Messages.InvalidDimensions(0, -1)).toContain('0');
      expect(Messages.DataLengthMismatch(40000, 100, 100, 1000)).toContain('40000');
      expect(Messages.ContextUnavailable).toContain('2D rendering context');
      expect(Messages.UnsupportedFormat('gif')).toContain('gif');
    });
  });

  describe('wasm builders', () => {
    it('formats decode failure messages with input size context', () => {
      expect(Messages.DecodeFailed(6)).toContain('input: 6 bytes');
      expect(Messages.DecodeFailedWithDetail('truncated', 6)).toContain('truncated');
      expect(Messages.DecodeFailedWithDetail('truncated', 6)).toContain('input: 6 bytes');
      expect(Messages.ProgressCallbackThrew('host')).toContain('onProgress callback threw');
      expect(Messages.ProgressCallbackThrew('host')).toContain('host');
      expect(Messages.DecoderFreedDuringDecode).toContain(
        'Decoder was freed before decoding completed'
      );
      expect(Messages.DecodeInputAllocFailed(1024)).toContain('1024 bytes');
    });
  });

  describe('worker builders', () => {
    it('names the worker script when a URL is known', () => {
      const message = Messages.WorkerFailed('/worker.js');
      expect(message).toContain('Worker failed');
      expect(message).toContain('could not load worker script at /worker.js');
      expect(message).toContain('text/javascript');
    });

    it('falls back to a bare message when the worker URL is unknown', () => {
      expect(Messages.WorkerFailed()).toBe('Worker failed');
      expect(Messages.WorkerFailed(undefined)).toBe('Worker failed');
    });

    it('accepts URL instances in the failure hint', () => {
      const url = new URL('https://example.com/w.js');
      expect(Messages.WorkerFailed(url)).toContain(String(url));
    });

    it('formats minimal timeout diagnostics', () => {
      const message = Messages.WorkerTimeout(5000, { progressMessages: 0 });
      expect(message).toContain('timed out after 5000ms');
      expect(message).toContain('0 progress message(s) received');
      expect(message).not.toContain('last percent');
      expect(message).not.toContain('unknown message type');
      expect(message).toContain('Increase timeoutMs');
    });

    it('formats full timeout diagnostics with percent, unknown type, and worker URL', () => {
      const message = Messages.WorkerTimeout(1000, {
        progressMessages: 3,
        lastPercent: 40,
        unknownType: 'log',
        workerUrl: '/slow.js',
      });
      expect(message).toContain('3 progress message(s) received');
      expect(message).toContain('last percent 40');
      expect(message).toContain("last unknown message type 'log'");
      expect(message).toContain('worker /slow.js');
    });

    it('includes the create/post failure causes verbatim', () => {
      expect(Messages.WorkerCreateFailed('SecurityError')).toContain('SecurityError');
      expect(Messages.WorkerPostFailed('DataCloneError')).toContain('DataCloneError');
      expect(Messages.WorkerConversionFailed).toContain('Worker conversion failed');
      expect(Messages.WorkerUnsupported).toContain('Web Worker is not supported');
      expect(Messages.WorkerDecoderUnsupported).toContain('decoder option is not supported');
    });
  });

  describe('0.5.0 option and feature messages', () => {
    it('formats output shape rejection', () => {
      const message = Messages.OutputShapeInvalid('base64');
      expect(message).toContain("output must be one of 'blob', 'dataUrl', 'arrayBuffer'");
      expect(message).toContain('got: base64');
    });

    it('formats boolean option rejections', () => {
      expect(Messages.ReuseDecodersInvalid(1)).toContain('reuseDecoders must be a boolean');
      expect(Messages.ContinueOnErrorInvalid('yes')).toContain('continueOnError must be a boolean');
    });

    it('formats signal rejection', () => {
      expect(Messages.SignalInvalid({})).toContain('signal must be an AbortSignal');
    });

    it('formats the abort message', () => {
      expect(Messages.Aborted).toContain('abort');
    });

    it('names the format and suggests fallbacks in format_unsupported', () => {
      const message = Messages.FormatUnsupported('avif');
      expect(message).toContain('avif');
      expect(message).toContain('cannot encode');
      expect(message).toContain("'jpeg'");
    });

    it('distinguishes positive-integer and non-negative-integer crop fields', () => {
      expect(Messages.CropInvalid('width', 0)).toContain('crop.width must be a positive integer');
      expect(Messages.CropInvalid('height', 1.5)).toContain('crop.height must be a positive integer');
      expect(Messages.CropInvalid('x', -1)).toContain('crop.x must be a non-negative integer');
      expect(Messages.CropInvalid('y', 2.5)).toContain('crop.y must be a non-negative integer');
    });

    it('reports crop bounds against the display dimensions', () => {
      const message = Messages.CropOutOfBounds(100, 50, 200, 150, 1600, 1200);
      expect(message).toContain('crop 200x150 at (100, 50)');
      expect(message).toContain('exceeds the 1600x1200 image');
      expect(message).toContain('post-orientation display pixels');
    });
  });
});
