const TXT_STATUSES = new Set(['success', 'empty']);

/**
 * Convert an extractTxt result into a search-core record and separate app data.
 * The caller must provide an ID; this adapter does not generate or persist IDs.
 */
export function adaptTxtRecord(extracted, { id } = {}) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('A non-empty caller-provided id is required.');
  }

  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) {
    throw new TypeError('TXT extraction result must be an object.');
  }
  if (typeof extracted.fileName !== 'string' || extracted.fileName.length === 0) {
    throw new TypeError('TXT extraction result must include a non-empty fileName.');
  }
  if (extracted.fileType !== 'TXT') {
    throw new TypeError('TXT extraction result must have fileType "TXT".');
  }
  if (typeof extracted.content !== 'string') {
    throw new TypeError('TXT extraction result must include string content.');
  }
  if (typeof extracted.metadata !== 'string') {
    throw new TypeError('TXT extraction result must include string metadata.');
  }
  if (!TXT_STATUSES.has(extracted.status)) {
    throw new TypeError('TXT extraction result must have status "success" or "empty".');
  }
  if (!extracted.sourceMetadata
      || typeof extracted.sourceMetadata !== 'object'
      || Array.isArray(extracted.sourceMetadata)) {
    throw new TypeError('TXT extraction result must include sourceMetadata.');
  }

  return {
    searchRecord: {
      id,
      title: extracted.fileName,
      fileName: extracted.fileName,
      fileType: extracted.fileType,
      metadata: extracted.metadata,
      content: extracted.content
    },
    appData: {
      status: extracted.status,
      sourceMetadata: { ...extracted.sourceMetadata }
    }
  };
}
