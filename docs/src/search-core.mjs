function removeVietnameseTones(value) {
  if (typeof value !== 'string' || !value) return '';
  return value.normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function tokenize(value) {
  if (typeof value !== 'string' || !value) return [];
  return value.normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0);
}

function normalizePhrase(value) {
  return removeVietnameseTones(String(value || '').normalize('NFC').toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeWithPositions(value) {
  const tokens = [];
  const expression = /[\p{L}\p{N}]+/gu;
  let match;
  while ((match = expression.exec(value)) !== null) {
    tokens.push({
      value: removeVietnameseTones(match[0].normalize('NFC').toLowerCase()),
      index: match.index,
      end: expression.lastIndex
    });
  }
  return tokens;
}

function buildTermFreq(words) {
  const frequencies = new Map();
  for (const word of words) {
    frequencies.set(word, (frequencies.get(word) || 0) + 1);
  }
  return frequencies;
}

function containsPhrase(text, phrase) {
  if (!phrase) return false;
  let index = text.indexOf(phrase);
  while (index !== -1) {
    const end = index + phrase.length;
    if ((index === 0 || text[index - 1] === ' ')
      && (end === text.length || text[end] === ' ')) return true;
    index = text.indexOf(phrase, index + 1);
  }
  return false;
}

function compareSearchEntries(left, right) {
  return right.result.rawScore - left.result.rawScore
    || left.result.fileName.localeCompare(right.result.fileName)
    || left.order - right.order;
}

function keepTopSearchEntry(heap, entry, limit) {
  if (limit <= 0) return;
  if (heap.length < limit) {
    heap.push(entry);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareSearchEntries(heap[child], heap[parent]) <= 0) break;
      [heap[child], heap[parent]] = [heap[parent], heap[child]];
      child = parent;
    }
    return;
  }

  if (compareSearchEntries(entry, heap[0]) >= 0) return;
  heap[0] = entry;
  let parent = 0;
  while (true) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let worst = parent;
    if (left < heap.length && compareSearchEntries(heap[left], heap[worst]) > 0) worst = left;
    if (right < heap.length && compareSearchEntries(heap[right], heap[worst]) > 0) worst = right;
    if (worst === parent) break;
    [heap[parent], heap[worst]] = [heap[worst], heap[parent]];
    parent = worst;
  }
}

function prepareDocument(record) {
  const titleWords = tokenize(record.title);
  const fileNameWords = tokenize(record.fileName);
  const metadataWords = tokenize(record.metadata);
  const contentWords = tokenize(record.content);
  const contentWordsNorm = contentWords.map(removeVietnameseTones);
  const content = record.content || '';

  return {
    record,
    titleTokensNorm: new Set(titleWords.map(removeVietnameseTones)),
    fileNameTokensNorm: new Set(fileNameWords.map(removeVietnameseTones)),
    metadataTokensNorm: new Set(metadataWords.map(removeVietnameseTones)),
    contentWordsNorm,
    contentFreqNorm: buildTermFreq(contentWordsNorm),
    wordCount: contentWords.length,
    titleNorm: normalizePhrase(record.title),
    fileNameNorm: normalizePhrase(record.fileName),
    metadataNorm: normalizePhrase(record.metadata),
    contentNorm: normalizePhrase(content),
    contentSnippetTokens: null
  };
}

function updatePosting(postingsByTerm, term, id, direction) {
  let posting = postingsByTerm.get(term);
  if (direction > 0) {
    if (!posting) {
      posting = new Set();
      postingsByTerm.set(term, posting);
    }
    posting.add(id);
  } else if (posting) {
    posting.delete(id);
    if (posting.size === 0) postingsByTerm.delete(term);
  }
}

function updateDocumentPostings(index, document, direction) {
  const record = document.record;
  const fields = [
    ['content', document.contentFreqNorm.keys()],
    ['title', document.titleTokensNorm],
    ['fileName', document.fileNameTokensNorm],
    ['metadata', document.metadataTokensNorm]
  ];
  for (const [field, terms] of fields) {
    const postingsByTerm = index.invertedIndex[field];
    for (const term of terms) updatePosting(postingsByTerm, term, record.id, direction);
  }
}

function updateContentStats(index, document, direction) {
  index.totalWordCount += direction * document.wordCount;
  for (const term of document.contentFreqNorm.keys()) {
    const nextFrequency = (index.termDocumentFrequency.get(term) || 0) + direction;
    if (nextFrequency > 0) index.termDocumentFrequency.set(term, nextFrequency);
    else index.termDocumentFrequency.delete(term);
  }
}

function getCandidateDocumentIds(index, terms, fileType) {
  const fieldPostings = Object.values(index.invertedIndex);
  const minimumMatches = terms.length >= 3 ? 2 : 1;
  const fileTypeFilter = fileType && fileType.toLowerCase() !== 'all'
    ? fileType.toLowerCase()
    : null;
  const termsByPostingSize = terms.map((term, termIndex) => {
    const postings = fieldPostings.map(postingsByTerm => postingsByTerm.get(term)).filter(Boolean);
    return {
      termIndex,
      postings,
      estimatedSize: postings.reduce((size, posting) => size + posting.size, 0)
    };
  }).sort((left, right) => left.estimatedSize - right.estimatedSize || left.termIndex - right.termIndex);

  const matchedTermCounts = new Map();
  const candidates = new Set();
  for (const term of termsByPostingSize) {
    for (const posting of term.postings) {
      for (const id of posting) {
        let state = matchedTermCounts.get(id);
        if (state && state.lastTermIndex === term.termIndex) continue;
        if (!state) {
          state = { count: 0, lastTermIndex: -1 };
          matchedTermCounts.set(id, state);
        }
        state.lastTermIndex = term.termIndex;

        if (fileTypeFilter) {
          const document = index.documents.get(id);
          if (!document || (document.record.fileType || '').toLowerCase() !== fileTypeFilter) continue;
        }

        state.count++;
        if (state.count >= minimumMatches) candidates.add(id);
      }
    }
  }
  return candidates;
}

function calculateProximity(words, terms) {
  const queryTerms = terms.map(removeVietnameseTones);
  if (!words || !queryTerms.length || words.length < queryTerms.length) {
    return { found: false, score: 0, span: 0, isAdjacent: false, isNear: false };
  }

  const requiredCounts = buildTermFreq(queryTerms);
  const relevantTerms = new Set(requiredCounts.keys());
  const windowCounts = new Map();
  let coveredOccurrences = 0;
  let left = 0;
  let minSpan = Infinity;

  for (let right = 0; right < words.length; right++) {
    const rightTerm = words[right];
    if (relevantTerms.has(rightTerm)) {
      const count = (windowCounts.get(rightTerm) || 0) + 1;
      windowCounts.set(rightTerm, count);
      if (count <= requiredCounts.get(rightTerm)) coveredOccurrences++;
    }

    while (coveredOccurrences === queryTerms.length) {
      const span = right - left + 1;
      minSpan = Math.min(minSpan, span);
      if (span === queryTerms.length) {
        return { found: true, span, isAdjacent: true, isNear: true, score: 100 };
      }
      const leftTerm = words[left];
      if (relevantTerms.has(leftTerm)) {
        const count = windowCounts.get(leftTerm);
        if (count <= requiredCounts.get(leftTerm)) coveredOccurrences--;
        windowCounts.set(leftTerm, count - 1);
      }
      left++;
    }
  }

  if (!Number.isFinite(minSpan)) {
    return { found: false, score: 0, span: 0, isAdjacent: false, isNear: false };
  }

  const extraWords = minSpan - queryTerms.length;
  const isAdjacent = extraWords === 0;
  const isNear = minSpan <= Math.max(queryTerms.length * 3, queryTerms.length + 4);
  return {
    found: true,
    span: minSpan,
    isAdjacent,
    isNear,
    score: 100 / (1 + extraWords * 0.35)
  };
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function highlightTerms(text, terms) {
  if (!text) return '';
  const queryTokens = terms.map(removeVietnameseTones);
  if (!queryTokens.length) return escapeHtml(text);
  const tokens = tokenizeWithPositions(text);

  for (let start = 0; start <= tokens.length - queryTokens.length; start++) {
    const isExactPhrase = queryTokens.every((term, offset) => tokens[start + offset].value === term);
    if (!isExactPhrase) continue;
    const phraseStart = tokens[start].index;
    const phraseEnd = tokens[start + queryTokens.length - 1].end;
    return escapeHtml(text.slice(0, phraseStart))
      + `<mark class="hl-phrase">${escapeHtml(text.slice(phraseStart, phraseEnd))}</mark>`
      + escapeHtml(text.slice(phraseEnd));
  }

  const queryTokenSet = new Set(queryTokens);
  let result = '';
  let cursor = 0;
  for (const token of tokens) {
    if (!queryTokenSet.has(token.value)) continue;
    result += escapeHtml(text.slice(cursor, token.index));
    result += `<mark class="hl-term">${escapeHtml(text.slice(token.index, token.end))}</mark>`;
    cursor = token.end;
  }
  return result + escapeHtml(text.slice(cursor));
}

function generateSnippet(document, query, queryTerms) {
  const contentText = document.record.content;
  if (!contentText) return 'Nội dung văn bản không có hoặc ở dạng hình ảnh.';

  const tokens = document.contentSnippetTokens
    || (document.contentSnippetTokens = tokenizeWithPositions(contentText));
  const queryTokens = [...new Set(queryTerms.map(removeVietnameseTones))];
  const queryTokenSet = new Set(queryTokens);
  let matchIndex = -1;
  if (queryTokens.length && tokens.length) {
    const counts = new Map();
    let covered = 0;
    let left = 0;
    let bestSpan = Infinity;
    for (let right = 0; right < tokens.length; right++) {
      const term = tokens[right].value;
      if (queryTokenSet.has(term)) {
        const count = (counts.get(term) || 0) + 1;
        counts.set(term, count);
        if (count === 1) covered++;
      }

      while (covered === queryTokenSet.size) {
        const span = right - left;
        if (span < bestSpan) {
          bestSpan = span;
          matchIndex = tokens[left].index;
        }
        const leftTerm = tokens[left].value;
        if (queryTokenSet.has(leftTerm)) {
          const count = counts.get(leftTerm) - 1;
          counts.set(leftTerm, count);
          if (count === 0) covered--;
        }
        left++;
      }
    }

    if (matchIndex === -1) {
      const firstMatch = tokens.find(token => queryTokenSet.has(token.value));
      if (firstMatch) matchIndex = firstMatch.index;
    }
  }

  if (matchIndex === -1) matchIndex = 0;
  const start = Math.max(0, matchIndex - 70);
  const end = Math.min(contentText.length, start + 220);
  let snippetText = contentText.slice(start, end).trim();
  if (start > 0) snippetText = `...${snippetText}`;
  if (end < contentText.length) snippetText += '...';
  return highlightTerms(snippetText, queryTerms);
}

export function createSearchIndex(records) {
  const index = {
    documents: new Map(),
    termDocumentFrequency: new Map(),
    totalWordCount: 0,
    invertedIndex: {
      content: new Map(),
      title: new Map(),
      fileName: new Map(),
      metadata: new Map()
    },
    documentOrder: new Map(),
    nextDocumentOrder: 0
  };

  for (const record of records) {
    const document = prepareDocument(record);
    const id = record.id;
    const previous = index.documents.get(id);
    if (previous) {
      updateContentStats(index, previous, -1);
      updateDocumentPostings(index, previous, -1);
    } else {
      index.documentOrder.set(id, index.nextDocumentOrder++);
    }
    index.documents.set(id, document);
    updateContentStats(index, document, 1);
    updateDocumentPostings(index, document, 1);
  }
  return index;
}

export function search(index, rawQuery, options = {}) {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const { fileType = null, limit = 50, offset = 0, includeTotal = false } = options;
  const queryTerms = tokenize(query);
  const queryTermsNorm = queryTerms.map(removeVietnameseTones);
  const uniqueTerms = [...new Set(queryTermsNorm)];
  const queryPhrase = normalizePhrase(query);
  if (!query || !uniqueTerms.length || !queryPhrase) {
    return includeTotal ? { results: [], total: 0 } : [];
  }

  const validLimit = Number.isInteger(limit) && limit >= 0 ? limit : 50;
  const validOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const totalDocs = index.documents.size;
  const averageLength = totalDocs ? index.totalWordCount / totalDocs : 0;
  const idfByTerm = new Map();
  for (const term of uniqueTerms) {
    const documentFrequency = index.termDocumentFrequency.get(term) || 0;
    idfByTerm.set(term, Math.log(1 + (totalDocs - documentFrequency + 0.5) / (documentFrequency + 0.5)));
  }

  const candidateIds = getCandidateDocumentIds(index, uniqueTerms, fileType);
  const heapLimit = validOffset + validLimit;
  const topResults = [];
  let totalResults = 0;

  for (const id of candidateIds) {
    const document = index.documents.get(id);
    if (!document) continue;
    const record = document.record;
    let matchedTermsCount = 0;
    let titleMatches = 0;
    let fileNameMatches = 0;
    let metadataMatches = 0;
    let contentMatches = 0;
    let bm25Score = 0;
    const length = document.wordCount || 0;
    const lengthNormalization = averageLength > 0
      ? 1.2 * (1 - 0.75 + 0.75 * (length / averageLength))
      : 1.2;

    for (const term of uniqueTerms) {
      const inTitle = document.titleTokensNorm.has(term);
      const inFileName = document.fileNameTokensNorm.has(term);
      const inMetadata = document.metadataTokensNorm.has(term);
      const termFrequency = document.contentFreqNorm.get(term) || 0;
      const inContent = termFrequency > 0;
      if (inTitle) titleMatches++;
      if (inFileName) fileNameMatches++;
      if (inMetadata) metadataMatches++;
      if (inContent) {
        contentMatches++;
        const inverseDocumentFrequency = idfByTerm.get(term);
        bm25Score += inverseDocumentFrequency * (termFrequency * 2.2) / (termFrequency + lengthNormalization);
      }
      if (inTitle || inFileName || inMetadata || inContent) matchedTermsCount++;
    }

    if (matchedTermsCount === 0) continue;
    const exactTitle = titleMatches === uniqueTerms.length && (queryTerms.length === 1
      || containsPhrase(document.titleNorm, queryPhrase));
    const exactFileName = fileNameMatches === uniqueTerms.length && (queryTerms.length === 1
      || containsPhrase(document.fileNameNorm, queryPhrase));
    const exactMetadata = metadataMatches === uniqueTerms.length && (queryTerms.length === 1
      || containsPhrase(document.metadataNorm, queryPhrase));
    const exactContent = contentMatches === uniqueTerms.length && (queryTerms.length === 1
      || containsPhrase(document.contentNorm, queryPhrase));

    const coverage = matchedTermsCount / uniqueTerms.length;
    if (uniqueTerms.length >= 3 && matchedTermsCount < 2) continue;
    const allTermsInTitle = titleMatches === uniqueTerms.length;
    const contentHasAllTerms = contentMatches === uniqueTerms.length;
    const proximity = uniqueTerms.length > 1 && contentHasAllTerms
      ? calculateProximity(document.contentWordsNorm, queryTermsNorm)
      : { found: false, score: 0, span: 0, isAdjacent: false, isNear: false };
    const exactPhraseCount = exactContent
      ? countPhraseOccurrences(document.contentNorm, queryPhrase)
      : 0;
    const fieldScore = titleMatches * 40 + fileNameMatches * 25 + metadataMatches * 15;
    const partialPenalty = Math.pow(coverage, queryTerms.length >= 3 ? 3 : 2);
    const evidenceScore = (1 + fieldScore + bm25Score * 30 + proximity.score) * partialPenalty;
    let score = evidenceScore;
    const matchReasons = [];
    if (exactTitle) {
      score = 1000000000 + evidenceScore;
      matchReasons.push('🎯 Khớp chính xác cụm từ trong Tiêu đề');
    } else if (exactFileName) {
      score = 900000000 + evidenceScore;
      matchReasons.push('📁 Khớp chính xác cụm từ trong Tên file');
    } else if (exactMetadata) {
      score = 800000000 + evidenceScore;
      matchReasons.push('🏷️ Khớp chính xác cụm từ trong Metadata');
    } else if (exactContent) {
      score = 700000000 + Math.min(exactPhraseCount, 1000) * 1000 + evidenceScore;
      matchReasons.push(`🎯 Khớp cụm từ chính xác trong nội dung (${exactPhraseCount} lần)`);
    } else if (allTermsInTitle) {
      score = 600000000 + evidenceScore;
      matchReasons.push(`📌 Tất cả ${uniqueTerms.length} từ khóa xuất hiện trong Tiêu đề`);
    } else if (proximity.found && proximity.isNear) {
      score = 500000000 + proximity.score * 1000000 + evidenceScore;
      matchReasons.push(proximity.isAdjacent
        ? '⚡ Tất cả từ khóa xuất hiện liền kề trong nội dung'
        : `⚡ Tất cả từ khóa xuất hiện gần nhau (khoảng cách ${proximity.span} từ)`);
    }

    if (titleMatches > 0 && !exactTitle && !allTermsInTitle) {
      matchReasons.push(`📌 Khớp ${titleMatches}/${uniqueTerms.length} từ trong Tiêu đề`);
    }
    if (bm25Score > 0 && !exactContent) {
      matchReasons.push(`📊 BM25 có trọng số độ hiếm cho ${contentMatches} từ trong nội dung`);
    }
    if (coverage < 1) {
      matchReasons.push(`Khớp ${matchedTermsCount}/${uniqueTerms.length} từ khóa; đã giảm điểm theo độ bao phủ`);
    }

    totalResults++;
    keepTopSearchEntry(topResults, {
      id,
      order: index.documentOrder.get(id) ?? 0,
      result: {
        id: record.id,
        title: record.title,
        fileName: record.fileName,
        fileType: record.fileType,
        date: record.date,
        filePath: record.filePath,
        fileSize: record.fileSize,
        pageCount: record.pageCount,
        rawScore: score,
        snippet: '',
        matchReasons: matchReasons.slice(0, 3),
        matchedTermsCount,
        totalQueryTerms: queryTerms.length
      },
      document
    }, heapLimit);
  }

  topResults.sort(compareSearchEntries);
  if (topResults.length) {
    const topScore = topResults[0].result.rawScore;
    for (const entry of topResults) {
      const relativeScore = topScore > 0 ? entry.result.rawScore / topScore : 0;
      const resultCoverage = entry.result.matchedTermsCount / uniqueTerms.length;
      entry.result.relevanceScore = Math.round(relativeScore * (0.35 + 0.65 * resultCoverage) * 100);
    }
  }

  const pageEntries = topResults.slice(validOffset, validOffset + validLimit);
  for (const entry of pageEntries) {
    entry.result.snippet = generateSnippet(entry.document, query, queryTerms);
  }
  const results = pageEntries.map(entry => entry.result);
  return includeTotal ? { results, total: totalResults } : results;
}

function countPhraseOccurrences(content, phrase) {
  const paddedContent = ` ${content} `;
  const paddedPhrase = ` ${phrase} `;
  let count = 0;
  let index = 0;
  while ((index = paddedContent.indexOf(paddedPhrase, index)) !== -1) {
    count++;
    index += paddedPhrase.length;
  }
  return count;
}
