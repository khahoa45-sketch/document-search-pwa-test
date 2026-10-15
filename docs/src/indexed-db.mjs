const DATABASE_NAME = 'document-search-pwa';
const DATABASE_VERSION = 1;
const DOCUMENTS_STORE = 'documents';

function createOperationError(operation, detail, cause) {
  const error = new Error(`${operation}: ${detail}`);
  error.name = 'IndexedDBOperationError';
  error.code = 'INDEXED_DB_OPERATION_FAILED';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function validateTimestamp(value, fieldName) {
  if (typeof value !== 'string'
      || !/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.test(value)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 UTC date-time string.`);
  }

  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  const milliseconds = Date.parse(value);
  if (!parts || !Number.isFinite(milliseconds)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 UTC date-time string.`);
  }
  const date = new Date(milliseconds);
  const expected = parts.slice(1).map(Number);
  if (date.getUTCFullYear() !== expected[0]
      || date.getUTCMonth() + 1 !== expected[1]
      || date.getUTCDate() !== expected[2]
      || date.getUTCHours() !== expected[3]
      || date.getUTCMinutes() !== expected[4]
      || date.getUTCSeconds() !== expected[5]) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 UTC date-time string.`);
  }
}

function clonePlainData(value, fieldName, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') {
    throw new TypeError(`${fieldName} must contain only plain structured data.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${fieldName} must not contain circular references.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new TypeError(`${fieldName} must contain only plain structured data.`);
    }
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) {
      throw new TypeError(`${fieldName} arrays must not have custom properties.`);
    }
    const copy = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${fieldName} arrays must not contain empty slots.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${fieldName} must not contain accessors or hidden values.`);
      }
      copy.push(clonePlainData(descriptor.value, fieldName, ancestors));
    }
    ancestors.delete(value);
    return copy;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${fieldName} must contain only plain structured data.`);
  }
  ancestors.add(value);
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${fieldName} must not contain symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${fieldName} must not contain accessors or hidden values.`);
    }
    Object.defineProperty(copy, key, {
      value: clonePlainData(descriptor.value, fieldName, ancestors),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  ancestors.delete(value);
  return copy;
}

function validateDocument(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('addDocument: record must be an object.');
  }
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('addDocument: record must be a plain object.');
  }

  const allowedFields = new Set([
    'id',
    'title',
    'fileName',
    'fileType',
    'metadata',
    'content',
    'status',
    'sourceMetadata',
    'importedAt',
    'updatedAt'
  ]);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowedFields.has(key)) {
      throw new TypeError(`addDocument: unsupported record field "${String(key)}".`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('addDocument: record fields must be enumerable data properties.');
    }
  }

  for (const fieldName of ['id', 'title', 'fileName']) {
    if (typeof record[fieldName] !== 'string' || record[fieldName].trim().length === 0) {
      throw new TypeError(`addDocument: ${fieldName} must be a non-empty string.`);
    }
  }
  if (typeof record.fileType !== 'string') {
    throw new TypeError('addDocument: fileType must be a string.');
  }
  const fileType = record.fileType.trim().toUpperCase();
  if (fileType !== 'TXT') {
    throw new TypeError('addDocument: fileType must be TXT.');
  }
  if (typeof record.metadata !== 'string') {
    throw new TypeError('addDocument: metadata must be a string.');
  }
  if (typeof record.content !== 'string') {
    throw new TypeError('addDocument: content must be a string.');
  }
  if (record.status !== 'success' && record.status !== 'empty') {
    throw new TypeError('addDocument: status must be success or empty.');
  }
  if ((record.status === 'empty') !== (record.content.length === 0)) {
    throw new TypeError('addDocument: empty status must match whether content is empty.');
  }
  if (!record.sourceMetadata
      || typeof record.sourceMetadata !== 'object'
      || Array.isArray(record.sourceMetadata)) {
    throw new TypeError('addDocument: sourceMetadata must be a plain object.');
  }
  const sourceMetadata = clonePlainData(record.sourceMetadata, 'sourceMetadata');
  validateTimestamp(record.importedAt, 'importedAt');
  validateTimestamp(record.updatedAt, 'updatedAt');

  return {
    id: record.id,
    title: record.title,
    fileName: record.fileName,
    fileType,
    metadata: record.metadata,
    content: record.content,
    status: record.status,
    sourceMetadata,
    importedAt: record.importedAt,
    updatedAt: record.updatedAt
  };
}

function createDocumentStore(databaseName, invalidationSignal = null) {
  let databaseConnection = null;
  let databaseOpenPromise = null;
  let pendingOpenAttempt = null;
  const openAttempts = new Set();
  const failedCloseConnections = new Map();
  let invalidated = invalidationSignal?.aborted === true;

  function createInvalidationError(operation) {
    return createOperationError(
      operation,
      'The test store was invalidated and cannot start new database work.',
      new Error('Test store invalidated.')
    );
  }

  function assertActive(operation) {
    if (invalidated || invalidationSignal?.aborted === true) {
      invalidated = true;
      throw createInvalidationError(operation);
    }
  }

  function settleOpenAttempt(attempt, error, database) {
    if (attempt.callerSettled) return;
    attempt.callerSettled = true;
    if (error) attempt.reject(error);
    else attempt.resolve(database);
  }

  function invalidateStore() {
    invalidated = true;
    if (pendingOpenAttempt) {
      settleOpenAttempt(
        pendingOpenAttempt,
        createInvalidationError('openDatabase')
      );
    }
  }

  if (invalidationSignal && !invalidationSignal.aborted) {
    invalidationSignal.addEventListener('abort', invalidateStore, { once: true });
  }

  function trackCloseFailure(database, cause) {
    failedCloseConnections.set(database, cause);
    database.onclose = () => {
      if (databaseConnection === database) databaseConnection = null;
      failedCloseConnections.delete(database);
    };
  }

  function closeConnection(database, operation) {
    try {
      database.close();
      if (databaseConnection === database) databaseConnection = null;
      failedCloseConnections.delete(database);
    } catch (cause) {
      trackCloseFailure(database, cause);
      throw createOperationError(
        operation,
        'The managed database connection could not be closed.',
        cause
      );
    }
  }

  function setManagedConnection(database) {
    databaseConnection = database;
    database.onversionchange = () => {
      try {
        closeConnection(database, 'versionchange');
      } catch (error) {
        trackCloseFailure(database, error);
      }
    };
    database.onclose = () => {
      if (databaseConnection === database) databaseConnection = null;
      failedCloseConnections.delete(database);
    };
  }

  function openDatabaseConnection() {
    try {
      assertActive('openDatabase');
    } catch (error) {
      return Promise.reject(error);
    }
    if (databaseConnection) return Promise.resolve(databaseConnection);
    if (pendingOpenAttempt) return pendingOpenAttempt.promise;

    if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') {
      return Promise.reject(createOperationError(
        'openDatabase',
        'IndexedDB is not available in this environment.',
        new Error('Missing IndexedDB API.')
      ));
    }

    let request;
    try {
      request = indexedDB.open(databaseName, DATABASE_VERSION);
    } catch (cause) {
      return Promise.reject(createOperationError(
        'openDatabase',
        'The database open request could not be started.',
        cause
      ));
    }

    let resolveOpen;
    let rejectOpen;
    const promise = new Promise((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const attempt = {
      promise,
      resolve: resolveOpen,
      reject: rejectOpen,
      callerSettled: false,
      request,
      requestSettled: false
    };
    pendingOpenAttempt = attempt;
    openAttempts.add(attempt);
    databaseOpenPromise = promise;

    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
        database.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });
      }
    };
    request.onblocked = () => {
      settleOpenAttempt(attempt, createOperationError(
        'openDatabase',
        'The database upgrade is blocked by another open connection.',
        new Error('IndexedDB open request was blocked.')
      ));
      if (pendingOpenAttempt === attempt) pendingOpenAttempt = null;
      if (databaseOpenPromise === promise) databaseOpenPromise = null;
    };
    request.onerror = () => {
      attempt.requestSettled = true;
      openAttempts.delete(attempt);
      settleOpenAttempt(attempt, createOperationError(
        'openDatabase',
        'The database could not be opened.',
        request.error || new Error('IndexedDB open request failed.')
      ));
      if (pendingOpenAttempt === attempt) pendingOpenAttempt = null;
      if (databaseOpenPromise === promise) databaseOpenPromise = null;
    };
    request.onsuccess = () => {
      attempt.requestSettled = true;
      const database = request.result;
      if (invalidated || attempt.callerSettled) {
        try {
          closeConnection(database, 'openDatabase');
        } catch {
          // Keep failed connections tracked so closeDatabase can retry.
        }
        settleOpenAttempt(attempt, createInvalidationError('openDatabase'));
      } else {
        setManagedConnection(database);
        settleOpenAttempt(attempt, null, database);
      }
      openAttempts.delete(attempt);
      if (pendingOpenAttempt === attempt) pendingOpenAttempt = null;
      if (databaseOpenPromise === promise) databaseOpenPromise = null;
    };

    return promise;
  }

  function runDocumentTransaction(operation, mode, makeRequest, id) {
    try {
      assertActive(operation);
    } catch (error) {
      return Promise.reject(error);
    }
    return openDatabaseConnection().then(database => new Promise((resolve, reject) => {
      let transaction;
      let request;
      let requestResult;
      let failureCause = null;
      let settled = false;

      const rejectOperation = cause => {
        if (settled) return;
        settled = true;
        const detail = id === undefined
          ? 'The IndexedDB transaction failed.'
          : `The IndexedDB transaction failed for document "${id}".`;
        reject(createOperationError(operation, detail, cause));
      };

      try {
        assertActive(operation);
        transaction = database.transaction(DOCUMENTS_STORE, mode);
        request = makeRequest(transaction.objectStore(DOCUMENTS_STORE));
      } catch (cause) {
        rejectOperation(cause);
        return;
      }

      request.onsuccess = () => {
        requestResult = request.result;
      };
      request.onerror = () => {
        failureCause = request.error || failureCause;
      };
      transaction.onerror = () => {
        failureCause = transaction.error || failureCause;
      };
      transaction.onabort = () => {
        rejectOperation(failureCause
          || transaction.error
          || new Error('IndexedDB transaction aborted.'));
      };
      transaction.oncomplete = () => {
        if (failureCause) {
          rejectOperation(failureCause);
          return;
        }
        if (settled) return;
        settled = true;
        resolve(requestResult);
      };
    })).catch(cause => {
      if (cause && cause.name === 'IndexedDBOperationError') throw cause;
      throw createOperationError(operation, 'The database operation could not start.', cause);
    });
  }

  async function closeDatabase() {
    const connectionAtStart = databaseConnection;
    const openingAtStart = databaseOpenPromise;
    let connectionFromOpening = null;
    let openingError = null;
    if (!invalidated && invalidationSignal?.aborted !== true && openingAtStart) {
      try {
        connectionFromOpening = await openingAtStart;
      } catch (error) {
        openingError = error;
      }
    }

    const candidates = new Set(failedCloseConnections.keys());
    if (connectionAtStart) candidates.add(connectionAtStart);
    if (connectionFromOpening) candidates.add(connectionFromOpening);
    const cleanupErrors = [];
    for (const database of candidates) {
      if (!failedCloseConnections.has(database)
          && databaseConnection !== database) continue;
      try {
        closeConnection(database, 'closeDatabase');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (openingError && cleanupErrors.length > 0) {
      const error = createOperationError(
        'closeDatabase',
        'Opening failed and connection cleanup also failed.',
        openingError
      );
      error.cleanupErrors = cleanupErrors;
      throw error;
    }
    if (openingError) throw openingError;
    if (cleanupErrors.length > 0) {
      throw createOperationError(
        'closeDatabase',
        'The managed database connection could not be closed.',
        cleanupErrors[0]
      );
    }
  }

  return {
    openDatabase: openDatabaseConnection,
    addDocument(record) {
      let validatedRecord;
      try {
        validatedRecord = validateDocument(record);
      } catch (error) {
        return Promise.reject(error);
      }
      return runDocumentTransaction(
        'addDocument',
        'readwrite',
        store => store.add(validatedRecord),
        validatedRecord.id
      ).then(() => validatedRecord);
    },
    getDocument(id) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        return Promise.reject(new TypeError('getDocument: id must be a non-empty string.'));
      }
      return runDocumentTransaction(
        'getDocument',
        'readonly',
        store => store.get(id),
        id
      ).then(record => record === undefined ? null : record);
    },
    getAllDocuments() {
      return runDocumentTransaction(
        'getAllDocuments',
        'readonly',
        store => store.getAll()
      );
    },
    closeDatabase
  };
}

const defaultDocumentStore = createDocumentStore(DATABASE_NAME);

/**
 * Creates an isolated store for browser tests. The instance does not open a database
 * until one of its methods is called.
 * @param {string} databaseName
 * @returns {{openDatabase: Function, addDocument: Function, getDocument: Function, getAllDocuments: Function, closeDatabase: Function}}
 */
export function createTestDocumentStore(databaseName, options) {
  if (typeof databaseName !== 'string'
      || !/^document-search-pwa-test-[a-f0-9]{32}$/.test(databaseName)
      || databaseName === DATABASE_NAME) {
    throw new TypeError(
      'createTestDocumentStore: databaseName must use the reserved test name format.'
    );
  }
  const signal = options?.signal;
  if (!signal
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new TypeError('createTestDocumentStore: options.signal must be an AbortSignal.');
  }
  return createDocumentStore(databaseName, signal);
}

/**
 * Opens the application database and creates the version 1 documents store.
 * Concurrent callers share one opening request; failed attempts may be retried.
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  return defaultDocumentStore.openDatabase();
}

/**
 * Adds a validated extracted document without overwriting an existing ID.
 * Resolves with the stored record only after the write transaction commits.
 * @param {object} record
 * @returns {Promise<object>}
 */
export function addDocument(record) {
  return defaultDocumentStore.addDocument(record);
}

/**
 * Reads a document by its primary key, returning null when it does not exist.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export function getDocument(id) {
  return defaultDocumentStore.getDocument(id);
}

/**
 * Reads all documents. This loads all extracted content into RAM; its impact
 * must be evaluated when rebuilding the in-memory search index.
 * @returns {Promise<object[]>}
 */
export function getAllDocuments() {
  return defaultDocumentStore.getAllDocuments();
}

/**
 * Closes the managed application database connection. Committed transactions are not rolled back.
 * @returns {Promise<void>}
 */
export function closeDatabase() {
  return defaultDocumentStore.closeDatabase();
}
