(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.DocumentSearchFingerprint = api;
  }
})(globalThis, function () {
  const DEFAULT_CHUNK_SIZE = 1024 * 1024;
  const MAX_CHUNK_SIZE = 4 * 1024 * 1024;

  class FingerprintAbortError extends Error {
    constructor() {
      super("Fingerprint calculation was cancelled.");
      this.name = "FingerprintAbortError";
      this.code = "FINGERPRINT_ABORTED";
    }
  }

  class FingerprintReadError extends Error {
    constructor(cause) {
      super("Unable to read a file chunk.");
      this.name = "FingerprintReadError";
      this.code = "FINGERPRINT_READ_FAILED";
      this.cause = cause;
    }
  }

  class FingerprintHashError extends Error {
    constructor(cause) {
      super("Unable to calculate the SHA-256 fingerprint.");
      this.name = "FingerprintHashError";
      this.code = "FINGERPRINT_HASH_FAILED";
      this.cause = cause;
    }
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      throw new FingerprintAbortError();
    }
  }

  /**
   * Hash a File/Blob-like input with sequential slices.
   * Pass hash-wasm's createSHA256 factory, and optionally chunkSize and AbortSignal.
   * Cancellation is observed between reads; an in-flight arrayBuffer() read may finish first.
   */
  async function createFileFingerprint(file, options) {
    const settings = options || {};
    const createSHA256 = settings.createSHA256;
    const chunkSize = settings.chunkSize === undefined
      ? DEFAULT_CHUNK_SIZE
      : settings.chunkSize;
    const signal = settings.signal;

    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.slice !== "function") {
      throw new TypeError("file must provide a non-negative safe size and slice().");
    }
    if (typeof createSHA256 !== "function") {
      throw new TypeError("options.createSHA256 must be a hash-wasm factory.");
    }
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new TypeError("chunkSize must be a positive safe integer.");
    }
    if (chunkSize > MAX_CHUNK_SIZE) {
      throw new RangeError(`chunkSize must not exceed ${MAX_CHUNK_SIZE} bytes.`);
    }

    let hasher = null;
    let buffer = null;
    let chunk = null;

    try {
      throwIfAborted(signal);
      try {
        hasher = await createSHA256();
      } catch (error) {
        throw new FingerprintHashError(error);
      }
      throwIfAborted(signal);

      for (let offset = 0; offset < file.size; offset += chunkSize) {
        throwIfAborted(signal);
        const expectedLength = Math.min(chunkSize, file.size - offset);

        try {
          chunk = file.slice(offset, offset + expectedLength);
          if (!chunk || typeof chunk.arrayBuffer !== "function") {
            throw new TypeError("slice() did not return a Blob-like chunk.");
          }
          buffer = await chunk.arrayBuffer();
          if (Object.prototype.toString.call(buffer) !== "[object ArrayBuffer]" ||
              buffer.byteLength !== expectedLength) {
            throw new TypeError("The chunk has an unexpected byte length.");
          }
        } catch (error) {
          throwIfAborted(signal);
          throw new FingerprintReadError(error);
        }

        throwIfAborted(signal);
        const bytes = new Uint8Array(buffer);
        try {
          hasher.update(bytes);
        } catch (error) {
          throw new FingerprintHashError(error);
        } finally {
          bytes.fill(0);
          buffer = null;
          chunk = null;
        }
      }

      throwIfAborted(signal);
      let digest;
      try {
        digest = hasher.digest("hex");
      } catch (error) {
        throw new FingerprintHashError(error);
      }
      throwIfAborted(signal);

      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
        throw new FingerprintHashError(
          new TypeError("The hasher returned an invalid SHA-256 digest.")
        );
      }
      return `sha256:${digest.toLowerCase()}`;
    } finally {
      if (buffer) {
        new Uint8Array(buffer).fill(0);
      }
      buffer = null;
      chunk = null;
      hasher = null;
    }
  }

  return {
    createFileFingerprint,
    FingerprintAbortError,
    FingerprintReadError,
    FingerprintHashError
  };
});
