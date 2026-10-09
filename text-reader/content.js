// =====================================================================
//  Прочитай меня — content script
//  Работает в контексте страницы: озвучка (Web Speech API),
//  выбор голоса, подсветка читаемого слова и отдача текста для сохранения.
// =====================================================================

// --- Голоса ----------------------------------------------------------
// Список голосов в Web Speech API загружается АСИНХРОННО. Если вызвать
// getVoices() сразу после загрузки страницы, он вернёт пустой массив.
let voices = [];

function loadVoices() {
  voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
}

function findVoice(preferredURI) {
  loadVoices();
  if (preferredURI) {
    const found = voices.find((v) => v.voiceURI === preferredURI);
    if (found) return found;
  }
  // Русский голос: сначала точное ru-RU, затем любой, начинающийся с "ru".
  return (
    voices.find((v) => v.lang === "ru-RU") ||
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("ru"))
  );
}

loadVoices();
if (window.speechSynthesis && "onvoiceschanged" in window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    loadVoices();
    // Сообщаем попапу, что список голосов обновился (если он открыт).
    browser.runtime.sendMessage({ action: "voicesChanged" }).catch(() => {});
  };
}

// --- Подсветка читаемого слова --------------------------------------
let highlightSegments = null; // { segments:[...], text:"..." }
let highlightMarks = [];      // <mark> (fallback, если нет CSS Highlights)
let highlightStyle = null;    // <style> для ::highlight(...)

function injectHighlightStyle() {
  if (highlightStyle) return;
  highlightStyle = document.createElement("style");
  highlightStyle.textContent =
    "::highlight(read-it-word){background:#f9e2af;color:#1e1e2e;border-radius:3px;}" +
    "mark.read-it-word{background:#f9e2af;color:#1e1e2e;border-radius:3px;}";
  (document.head || document.documentElement).appendChild(highlightStyle);
}

function clearHighlight() {
  if (window.CSS && CSS.highlights && CSS.highlights.has("read-it-word")) {
    CSS.highlights.delete("read-it-word");
  }
  for (const m of highlightMarks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
  highlightMarks = [];
}

// Строим отображение «глобальный индекс символа → узел DOM + смещение»
// для текущего выделения (может охватывать несколько текстовых узлов).
function buildSelectionMap(range) {
  const ca = range.commonAncestorContainer;
  const root = ca.nodeType === Node.TEXT_NODE ? ca.parentNode : ca;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (!range.intersectsNode(n)) continue;
    let start = 0;
    let end = n.data.length;
    if (n === range.startContainer) start = range.startOffset;
    if (n === range.endContainer) end = range.endOffset;
    if (end > start) nodes.push({ node: n, start, end });
  }
  const segments = [];
  let global = 0;
  let text = "";
  for (const s of nodes) {
    const piece = s.node.data.slice(s.start, s.end);
    segments.push({ node: s.node, start: s.start, end: s.end, globalStart: global });
    text += piece;
    global += piece.length;
  }
  return { segments, text };
}

function domRangeForChars(start, end) {
  const segs = highlightSegments.segments;
  const findSeg = (pos) => {
    for (const s of segs) {
      const sEnd = s.globalStart + (s.end - s.start);
      if (pos >= s.globalStart && pos < sEnd) return s;
    }
    return segs[segs.length - 1];
  };
  const sSeg = findSeg(start);
  const eSeg = findSeg(Math.max(start, end - 1));
  const r = document.createRange();
  r.setStart(sSeg.node, sSeg.start + (start - sSeg.globalStart));
  r.setEnd(eSeg.node, eSeg.start + (end - eSeg.globalStart));
  return r;
}

function highlightWord(start, end) {
  if (!highlightSegments) return;
  if (start == null || start >= highlightSegments.text.length) return;

  const r = domRangeForChars(start, end);

  const useCSS = !!(window.CSS && CSS.highlights && typeof Highlight !== "undefined");
  if (useCSS) {
    CSS.highlights.set("read-it-word", new Highlight(r));
  } else {
    // Fallback: оборачиваем слово в <mark>. surroundContents упадёт,
    // если диапазон пересекает границы элементов — тогда просто пропускаем.
    try {
      const mark = document.createElement("mark");
      mark.className = "read-it-word";
      r.surroundContents(mark);
      highlightMarks.push(mark);
    } catch (e) {
      /* слово пересекает несколько элементов — не подсвечиваем */
    }
  }

  // Прокрутка к слову, только если оно вне видимой области.
  const el = r.startContainer.parentElement;
  if (el) {
    const rect = el.getBoundingClientRect();
    const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!inView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// --- Озвучка ---------------------------------------------------------
function speakText(text, opts) {
  opts = opts || {};
  if (!window.speechSynthesis) {
    console.warn("Прочитай меня: speechSynthesis не поддерживается");
    return;
  }

  text = (text || "").trim();
  if (!text) return; // нечего читать

  window.speechSynthesis.cancel(); // остановить предыдущее

  const rate = typeof opts.rate === "number" && opts.rate > 0 ? opts.rate : 1.0;
  const voice = findVoice(opts.voiceURI);

  // Подготовка подсветки (только когда читаем именно выделение).
  clearHighlight();
  highlightSegments = opts.highlight && opts.range ? buildSelectionMap(opts.range) : null;
  if (highlightSegments) injectHighlightStyle();

  const utterance = new SpeechSynthesisUtterance(text);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "ru-RU"; // русского голоса нет — просим браузер подобрать
  }
  utterance.rate = rate;

  if (highlightSegments) {
    utterance.onboundary = (e) => {
      // Интересуют только пословные границы (Firefox шлёт name="word").
      if (e.name && e.name !== "word") return;
      const start = e.charIndex;
      if (start == null) return;
      const slice = highlightSegments.text.slice(start);
      const m = /\s/.exec(slice);
      const end = m ? start + m.index : highlightSegments.text.length;
      highlightWord(start, end);
    };
    utterance.onend = cleanup;
    utterance.onerror = cleanup;
  }

  window.speechSynthesis.speak(utterance);

  function cleanup() {
    // Небольшая задержка, чтобы последнее слово осталось подсвеченным.
    setTimeout(clearHighlight, 600);
  }
}

// --- Обработка сообщений --------------------------------------------
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.action === "speak") {
    // Готовый текст (из контекстного меню).
    speakText(message.text, { rate: message.rate, voiceURI: message.voiceURI });
  } else if (message.action === "readSelection") {
    // Читаем то, что выделено прямо сейчас + подсвечиваем.
    const sel = window.getSelection();
    const text = sel.toString();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    speakText(text, {
      rate: message.rate,
      voiceURI: message.voiceURI,
      highlight: !!range && text.trim().length > 0,
      range: range
    });
  } else if (message.action === "stop") {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    clearHighlight();
  } else if (message.action === "getVoices") {
    loadVoices();
    sendResponse(
      voices.map((v) => ({
        name: v.name,
        lang: v.lang,
        voiceURI: v.voiceURI,
        default: !!v.default
      }))
    );
    return true; // держим канал сообщений открытым
  } else if (message.action === "getSelectionText") {
    sendResponse({ text: window.getSelection().toString() });
    return true;
  }
});
