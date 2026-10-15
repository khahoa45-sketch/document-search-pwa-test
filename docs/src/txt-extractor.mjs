const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const UTF8_BOM = [0xef, 0xbb, 0xbf];

class TxtExtractorError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

class TxtInputError extends TxtExtractorError {
  constructor(message) {
    super(message, 'TXT_INVALID_INPUT');
  }
}

class TxtTooLargeError extends TxtExtractorError {
  constructor(size) {
    super(`TXT input exceeds the ${MAX_FILE_SIZE}-byte limit.`, 'TXT_TOO_LARGE');
    this.size = size;
    this.maxSize = MAX_FILE_SIZE;
  }
}

class TxtReadError extends TxtExtractorError {
  constructor(cause) {
    super('Unable to read a TXT file chunk.', 'TXT_READ_FAILED', cause);
  }
}

class TxtUtf8Error extends TxtExtractorError {
  constructor(cause) {
    super('TXT input is not valid UTF-8.', 'TXT_INVALID_UTF8', cause);
  }
}

class TxtAbortError extends TxtExtractorError {
  constructor() {
    super('TXT extraction was cancelled.', 'TXT_ABORTED');
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new TxtAbortError();
}

function hasUtf8Bom(bytes) {
  return bytes.length >= UTF8_BOM.length
    && UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

/**
 * Extract UTF-8 text from a File or Blob-like object using sequential 256 KiB slices.
 * Throws a coded TxtExtractorError on unsupported input, read/decode failure, oversize input, or cancellation.
 */
export async function extractTxt(file, { signal } = {}) {
  if (!file
      || typeof file.name !== 'string'
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || typeof file.slice !== 'function') {
    throw new TxtInputError('file must have a name, a non-negative safe size, and slice().');
  }
  if (file.size > MAX_FILE_SIZE) throw new TxtTooLargeError(file.size);

  let decoder = null;
  let chunk = null;
  let buffer = null;
  let bytes = null;
  let content = '';
  let bomDetected = false;

  try {
    throwIfAborted(signal);
    decoder = new TextDecoder('utf-8', { fatal: true });

    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      throwIfAborted(signal);
      const expectedLength = Math.min(CHUNK_SIZE, file.size - offset);

      try {
        chunk = file.slice(offset, offset + expectedLength);
        if (!chunk || typeof chunk.arrayBuffer !== 'function') {
          throw new TypeError('slice() did not return a Blob-like chunk.');
        }
        buffer = await chunk.arrayBuffer();
        if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]'
            || buffer.byteLength !== expectedLength) {
          throw new TypeError('The chunk has an unexpected byte length.');
        }
      } catch (error) {
        throwIfAborted(signal);
        throw new TxtReadError(error);
      }

      throwIfAborted(signal);
      bytes = new Uint8Array(buffer);
      try {
        if (offset === 0) bomDetected = hasUtf8Bom(bytes);
        content += decoder.decode(bytes, { stream: true });
      } catch (error) {
        throw new TxtUtf8Error(error);
      } finally {
        bytes.fill(0);
        bytes = null;
        buffer = null;
        chunk = null;
      }
    }

    throwIfAborted(signal);
    try {
      content += decoder.decode();
    } catch (error) {
      throw new TxtUtf8Error(error);
    }
    throwIfAborted(signal);

    return {
      fileName: file.name,
      fileType: 'TXT',
      content,
      metadata: '',
      sourceMetadata: {
        fileSize: file.size,
        ...(Number.isFinite(file.lastModified)
          ? { lastModified: file.lastModified }
          : {}),
        encoding: 'utf-8',
        bomDetected
      },
      status: content.length === 0 ? 'empty' : 'success'
    };
  } finally {
    if (bytes) bytes.fill(0);
    if (buffer) new Uint8Array(buffer).fill(0);
    decoder = null;
    chunk = null;
    buffer = null;
    bytes = null;
    content = '';
  }
}

export {
  CHUNK_SIZE as TXT_CHUNK_SIZE,
  MAX_FILE_SIZE as TXT_MAX_FILE_SIZE,
  TxtAbortError,
  TxtExtractorError,
  TxtInputError,
  TxtReadError,
  TxtTooLargeError,
  TxtUtf8Error
};
