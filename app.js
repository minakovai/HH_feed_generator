const checkBtn = document.getElementById('checkBtn');
const generateBtn = document.getElementById('generateBtn');
const coursesUrlInput = document.getElementById('coursesUrl');
const feedUrlInput = document.getElementById('feedUrl');
const corsProxyInput = document.getElementById('corsProxy');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const tableBody = document.querySelector('#resultTable tbody');

let lastRun = null;

const priceSelectors = ['price', 'cost', 'full_price'];
const installmentSelectors = ['installment', 'price_installment', 'credit'];
const urlSelectors = ['url', 'link'];
const titleSelectors = ['title', 'name'];
const defaultProxies = [
  'https://api.allorigins.win/raw?url=',
  'https://r.jina.ai/http://',
  'https://r.jina.ai/https://',
];

function setStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function normalizeUrlPath(urlString) {
  try {
    const url = new URL(urlString, window.location.origin);
    return url.pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

function parseRubPrice(value) {
  if (!value) return null;
  const digits = String(value).replace(/\s+/g, '').replace(/[^\d.,]/g, '').replace(',', '.');
  if (!digits) return null;
  const number = Number(digits);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function buildProxyUrl(targetUrl, proxy) {
  if (proxy.includes('r.jina.ai/http://') || proxy.includes('r.jina.ai/https://')) {
    const normalized = targetUrl.replace(/^https?:\/\//, '');
    return `${proxy}${normalized}`;
  }

  const glue = proxy.includes('?') || proxy.endsWith('=') ? '' : '/';
  return `${proxy}${glue}${encodeURIComponent(targetUrl)}`;
}

async function fetchDirect(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchViaProxy(url, proxy) {
  const proxiedUrl = buildProxyUrl(url, proxy);
  const res = await fetch(proxiedUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchText(url, corsProxy) {
  const attempts = [];

  try {
    return await fetchDirect(url);
  } catch (error) {
    attempts.push(`прямой запрос: ${error.message}`);
  }

  if (corsProxy) {
    try {
      return await fetchViaProxy(url, corsProxy);
    } catch (error) {
      attempts.push(`пользовательский прокси (${corsProxy}): ${error.message}`);
    }
  }

  for (const proxy of defaultProxies) {
    if (proxy === corsProxy) continue;
    try {
      return await fetchViaProxy(url, proxy);
    } catch (error) {
      attempts.push(`резервный прокси (${proxy}): ${error.message}`);
    }
  }

  throw new Error(
    `Failed to fetch. Не удалось получить ${url}. Попытки: ${attempts.join('; ')}`,
  );
}

function findFirstText(node, tags) {
  for (const tag of tags) {
    const found = node.querySelector(tag);
    if (found?.textContent?.trim()) {
      return { text: found.textContent.trim(), node: found, tag };
    }
  }
  return { text: '', node: null, tag: null };
}

function extractCourses(coursesHtml, sourceUrl) {
  const doc = new DOMParser().parseFromString(coursesHtml, 'text/html');
  const cards = [...doc.querySelectorAll('a[href*="/courses/"]')];

  const pricesByPath = new Map();

  for (const link of cards) {
    const href = link.getAttribute('href');
    if (!href) continue;

    const normalizedPath = normalizeUrlPath(new URL(href, sourceUrl).toString());
    if (!normalizedPath) continue;

    const searchArea = link.closest('article, li, section, div') || link;
    const text = searchArea.textContent || '';
    const matched = text.match(/(\d[\d\s]{2,})\s*₽/);
    const candidatePrice = parseRubPrice(matched?.[1]);

    if (!candidatePrice) continue;

    const existing = pricesByPath.get(normalizedPath);
    if (!existing || candidatePrice > existing.price) {
      pricesByPath.set(normalizedPath, {
        price: candidatePrice,
        title: link.textContent.trim() || normalizedPath,
      });
    }
  }

  return pricesByPath;
}

function extractFeed(feedXml) {
  const xmlDoc = new DOMParser().parseFromString(feedXml, 'application/xml');
  const parserError = xmlDoc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Невозможно разобрать XML фида.');
  }

  const items = [...xmlDoc.querySelectorAll('item, offer, vacancy, job')];

  const parsed = items
    .map((item, index) => {
      const urlData = findFirstText(item, urlSelectors);
      const titleData = findFirstText(item, titleSelectors);
      const priceData = findFirstText(item, priceSelectors);
      const installmentData = findFirstText(item, installmentSelectors);

      const url = urlData.text;
      const path = normalizeUrlPath(url);

      return {
        index,
        item,
        url,
        path,
        title: titleData.text || `Элемент #${index + 1}`,
        price: parseRubPrice(priceData.text),
        installment: parseRubPrice(installmentData.text),
        priceNode: priceData.node,
        installmentNode: installmentData.node,
      };
    })
    .filter((entry) => entry.path);

  return { xmlDoc, parsed };
}

function renderResults(results) {
  tableBody.innerHTML = '';

  for (const r of results) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.title}</td>
      <td><a href="${r.url}" target="_blank" rel="noreferrer">${r.url}</a></td>
      <td>${r.feedPrice ?? '—'}</td>
      <td>${r.actualPrice ?? '—'}</td>
      <td>${r.feedInstallment ?? '—'}</td>
      <td>${r.actualInstallment ?? '—'}</td>
      <td><span class="badge ${r.statusClass}">${r.statusLabel}</span></td>
    `;
    tableBody.appendChild(tr);
  }
}

function applyCorrectionsToXml(xmlDoc, mismatches) {
  for (const m of mismatches) {
    if (m.actualPrice == null) continue;

    if (m.feedItem.priceNode) {
      m.feedItem.priceNode.textContent = String(m.actualPrice);
    }

    if (m.feedItem.installmentNode) {
      m.feedItem.installmentNode.textContent = String(m.actualInstallment);
    } else {
      const newNode = xmlDoc.createElement('installment');
      newNode.textContent = String(m.actualInstallment);
      m.feedItem.item.appendChild(newNode);
    }
  }

  const serializer = new XMLSerializer();
  return serializer.serializeToString(xmlDoc);
}

checkBtn.addEventListener('click', async () => {
  const coursesUrl = coursesUrlInput.value.trim();
  const feedUrl = feedUrlInput.value.trim();
  const corsProxy = corsProxyInput.value.trim();

  generateBtn.disabled = true;
  summaryEl.innerHTML = '';
  tableBody.innerHTML = '';

  try {
    setStatus('Загружаю страницу курсов и XML-фид (с авто-переключением на CORS-прокси при необходимости)…', 'info');

    const [coursesHtml, feedXml] = await Promise.all([
      fetchText(coursesUrl, corsProxy),
      fetchText(feedUrl, corsProxy),
    ]);

    const coursesMap = extractCourses(coursesHtml, coursesUrl);
    const { xmlDoc, parsed } = extractFeed(feedXml);

    if (!coursesMap.size) {
      throw new Error('Не удалось извлечь цены из страницы курсов. Проверьте CORS-прокси и структуру страницы.');
    }

    const results = parsed.map((item) => {
      const courseData = coursesMap.get(item.path);
      if (!courseData) {
        return {
          title: item.title,
          url: item.url,
          feedPrice: item.price,
          actualPrice: null,
          feedInstallment: item.installment,
          actualInstallment: null,
          statusLabel: 'Курс не найден на странице',
          statusClass: 'warning',
          mismatch: false,
          feedItem: item,
        };
      }

      const actualInstallment = Math.round(courseData.price / 12);
      const priceMismatch = item.price !== courseData.price;
      const installmentMismatch = item.installment !== actualInstallment;
      const mismatch = priceMismatch || installmentMismatch;

      return {
        title: item.title,
        url: item.url,
        feedPrice: item.price,
        actualPrice: courseData.price,
        feedInstallment: item.installment,
        actualInstallment,
        statusLabel: mismatch ? 'Есть расхождение' : 'Совпадает',
        statusClass: mismatch ? 'mismatch' : 'ok',
        mismatch,
        feedItem: item,
      };
    });

    const mismatches = results.filter((r) => r.mismatch);
    const correctedXml = applyCorrectionsToXml(xmlDoc, mismatches);

    lastRun = {
      results,
      mismatches,
      correctedXml,
      sourceXml: feedXml,
    };

    renderResults(results);

    const changed = correctedXml !== feedXml;
    summaryEl.innerHTML = `
      <p><strong>Всего проверено:</strong> ${results.length}</p>
      <p><strong>Расхождений:</strong> ${mismatches.length}</p>
      <p><strong>Изменения относительно исходного файла:</strong> ${changed ? 'да' : 'нет'}</p>
    `;

    if (changed) {
      setStatus('Проверка завершена. Найдены изменения, можно сгенерировать новый фид.', 'success');
      generateBtn.disabled = false;
    } else {
      setStatus('Проверка завершена. Расхождений нет, генерация не требуется.', 'success');
    }
  } catch (error) {
    console.error(error);
    setStatus(`Ошибка: ${error.message}`, 'error');
  }
});

generateBtn.addEventListener('click', () => {
  if (!lastRun?.correctedXml) return;

  const changed = lastRun.correctedXml !== lastRun.sourceXml;
  if (!changed) {
    setStatus('Изменений относительно исходного файла нет: файл не будет создан.', 'info');
    return;
  }

  const blob = new Blob([lastRun.correctedXml], { type: 'application/xml;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'feed_hh_new_corrected.xml';
  link.click();
  URL.revokeObjectURL(link.href);

  setStatus('Исправленный фид сгенерирован и скачан.', 'success');
});
