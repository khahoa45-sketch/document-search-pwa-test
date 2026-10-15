'use strict';

const searchForm = document.querySelector('#search-form');
const searchInput = document.querySelector('#search-input');
const documentPicker = document.querySelector('#document-picker');
const selectionStatus = document.querySelector('#selection-status');
const importErrors = document.querySelector('#import-errors');
const resultsState = document.querySelector('#results-state');
const resultsList = document.querySelector('#results-list');
const resultCount = document.querySelector('.result-count');

let searchRecords = [];
let searchIndex = null;
let isImporting = false;
let nextRecordId = 1;
let modulesAvailable = false;

const modulesReady = Promise.all([
  import('./txt-extractor.mjs'),
  import('./record-adapter.mjs'),
  import('./search-core.mjs')
]).then(([extractor, adapter, searchCore]) => {
  searchIndex = searchCore.createSearchIndex(searchRecords);
  modulesAvailable = true;
  return {
    extractTxt: extractor.extractTxt,
    adaptTxtRecord: adapter.adaptTxtRecord,
    createSearchIndex: searchCore.createSearchIndex,
    search: searchCore.search
  };
});

modulesReady.catch(error => {
  console.error('Không thể nạp các module tìm kiếm TXT:', error);
  selectionStatus.textContent = 'Không thể khởi tạo tìm kiếm TXT. Hãy tải lại ứng dụng.';
  documentPicker.disabled = true;
  searchInput.disabled = true;
});

function showEmptyState(message) {
  resultsState.style.display = '';
  resultsState.hidden = false;
  resultsState.querySelector('p').textContent = message;
  resultsList.replaceChildren();
}

function createSafeSnippet(snippet) {
  const fragment = document.createDocumentFragment();
  const targets = [fragment];
  const tokenPattern = /<mark class="(hl-term|hl-phrase)">|<\/mark>|&(?:amp|lt|gt|quot|#039);/g;
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#039;': '\''
  };
  let cursor = 0;
  let match;

  function appendText(text) {
    if (text) {
      targets[targets.length - 1].append(document.createTextNode(
        text.replace(/&(?:amp|lt|gt|quot|#039);/g, entity => entities[entity])
      ));
    }
  }

  while ((match = tokenPattern.exec(snippet)) !== null) {
    appendText(snippet.slice(cursor, match.index));
    if (match[1]) {
      const mark = document.createElement('mark');
      mark.className = match[1];
      targets[targets.length - 1].append(mark);
      targets.push(mark);
    } else if (match[0] === '</mark>' && targets.length > 1) {
      targets.pop();
    } else if (match[0] !== '</mark>') {
      appendText(match[0]);
    } else {
      targets[targets.length - 1].append(document.createTextNode(match[0]));
    }
    cursor = tokenPattern.lastIndex;
  }
  appendText(snippet.slice(cursor));
  return fragment;
}

function renderResults(results, total, query) {
  resultCount.textContent = String(total);
  if (results.length === 0) {
    showEmptyState(query
      ? 'Không tìm thấy tài liệu phù hợp trong các tệp TXT đã nhập.'
      : 'Nhập tên tệp hoặc từ khóa để tìm trong các tệp TXT đã nhập.');
    return;
  }

  resultsState.style.display = 'none';
  resultsState.hidden = true;
  const resultElements = results.map(result => {
    const article = document.createElement('article');
    article.className = 'search-result';

    const heading = document.createElement('h3');
    heading.textContent = result.title || result.fileName;
    article.append(heading);

    const fileDetails = document.createElement('p');
    fileDetails.textContent = `${result.fileName} · ${result.fileType}`;
    article.append(fileDetails);

    const snippet = document.createElement('p');
    snippet.className = 'result-snippet';
    snippet.replaceChildren(createSafeSnippet(result.snippet));
    article.append(snippet);
    return article;
  });
  resultsList.replaceChildren(...resultElements);
}

searchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const query = searchInput.value.trim();

  try {
    const modules = await modulesReady;
    const { results, total } = modules.search(searchIndex, query, { includeTotal: true });
    renderResults(results, total, query);
  } catch (error) {
    console.error('Không thể tìm kiếm tài liệu TXT:', error);
    resultCount.textContent = '0';
    showEmptyState('Đã xảy ra lỗi khi tìm kiếm. Hãy thử lại.');
  }
});

documentPicker.addEventListener('change', async () => {
  if (isImporting) return;
  const files = Array.from(documentPicker.files || []);
  documentPicker.value = '';
  if (files.length === 0) return;

  isImporting = true;
  documentPicker.disabled = true;
  importErrors.replaceChildren();
  selectionStatus.textContent = `Đang xử lý ${files.length} tệp TXT. Dữ liệu chỉ tồn tại trong RAM.`;

  let importCommitted = false;
  let committedImportedCount = 0;
  try {
    const modules = await modulesReady;
    const errors = [];
    const importedRecords = [];
    for (const file of files) {
      if (!/\.txt$/i.test(file.name)) {
        errors.push({ fileName: file.name, message: 'Chỉ hỗ trợ tệp có phần mở rộng .txt.' });
        continue;
      }

      try {
        const extracted = await modules.extractTxt(file);
        const { searchRecord } = modules.adaptTxtRecord(extracted, {
          id: `ram-session-${nextRecordId++}`
        });
        importedRecords.push(searchRecord);
      } catch (error) {
        errors.push({
          fileName: file.name,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    let importedCount = 0;
    if (importedRecords.length > 0) {
      const updatedRecords = [...searchRecords, ...importedRecords];
      const updatedIndex = modules.createSearchIndex(updatedRecords);
      searchRecords = updatedRecords;
      searchIndex = updatedIndex;
      importedCount = importedRecords.length;
      committedImportedCount = importedCount;
      importCommitted = true;
    }

    if (errors.length > 0) {
      const errorItems = errors.map(({ fileName, message }) => {
        const item = document.createElement('li');
        item.textContent = `${fileName}: ${message}`;
        return item;
      });
      importErrors.replaceChildren(...errorItems);
    }

    const successfulTotal = searchRecords.length;
    selectionStatus.textContent = `${importedCount} tệp nhập thành công trong lần này; tổng cộng ${successfulTotal} tệp trong RAM. ID chỉ dùng trong phiên hiện tại; dữ liệu chưa được lưu bền vững.`;
    if (importedCount > 0 && searchInput.value.trim()) {
      searchForm.requestSubmit();
    }
  } catch (error) {
    console.error('Không thể hoàn tất nhập TXT:', error);
    selectionStatus.textContent = importCommitted
      ? `${committedImportedCount} tệp đã được thêm vào chỉ mục trong RAM, nhưng có lỗi ở bước cập nhật giao diện/hậu xử lý.`
      : 'Không thể hoàn tất nhập TXT. Chỉ mục và các bản ghi trước đó được giữ nguyên.';
    const item = document.createElement('li');
    item.textContent = `Lỗi nhập: ${error instanceof Error ? error.message : String(error)}`;
    importErrors.replaceChildren(item);
  } finally {
    isImporting = false;
    documentPicker.disabled = !modulesAvailable;
  }
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./service-worker.js').catch(error => {
    console.error('Không thể đăng ký Service Worker:', error);
  });
}
