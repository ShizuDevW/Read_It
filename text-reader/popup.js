const btnRead = document.getElementById("btn-read");
const btnStop = document.getElementById("btn-stop");
const btnSave = document.getElementById("btn-save");
const rateSlider = document.getElementById("rate");
const rateValue = document.getElementById("rate-value");
const voiceSelect = document.getElementById("voice");
const statusEl = document.getElementById("status");

function showStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "";
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// --- Настройки (синхронизируем с content-скриптом через storage) -----
async function loadSettings() {
  const { rate, voiceURI } = await browser.storage.local.get(["rate", "voiceURI"]);
  if (typeof rate === "number") {
    rateSlider.value = String(rate);
    rateValue.textContent = rate.toFixed(1);
  }
  if (voiceURI) voiceSelect.dataset.saved = voiceURI;
}

async function saveSettings() {
  await browser.storage.local.set({
    rate: parseFloat(rateSlider.value),
    voiceURI: voiceSelect.value || null
  });
}

// --- Список голосов ---------------------------------------------------
async function refreshVoices() {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const list = await browser.tabs.sendMessage(tab.id, { action: "getVoices" });
    if (!Array.isArray(list)) return;

    const current = voiceSelect.value;
    const saved = voiceSelect.dataset.saved || "";
    voiceSelect.innerHTML = '<option value="">— русский по умолчанию —</option>';

    // Сначала русские голоса, затем остальные по алфавиту.
    const sorted = [...list].sort((a, b) => {
      const ar = a.lang.toLowerCase().startsWith("ru") ? 0 : 1;
      const br = b.lang.toLowerCase().startsWith("ru") ? 0 : 1;
      return ar - br || a.name.localeCompare(b.name);
    });

    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})${v.default ? " •" : ""}`;
      voiceSelect.appendChild(opt);
    }

    // Восстанавливаем выбор пользователя / сохранённый голос.
    const restore = current || saved;
    if (restore && [...voiceSelect.options].some((o) => o.value === restore)) {
      voiceSelect.value = restore;
    }
  } catch (e) {
    // На страницах без content-скрипта (about:*, addons.mozilla.org) —
    // список недоступен, это не критично.
  }
}

// Content-скрипт присылает это, когда догрузил голоса.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === "voicesChanged") refreshVoices();
});

// --- Кнопки -----------------------------------------------------------
rateSlider.addEventListener("input", () => {
  rateValue.textContent = parseFloat(rateSlider.value).toFixed(1);
  saveSettings();
});

voiceSelect.addEventListener("change", saveSettings);

btnRead.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) {
    showStatus("Нет активной вкладки.", true);
    return;
  }
  try {
    await browser.tabs.sendMessage(tab.id, {
      action: "readSelection",
      rate: parseFloat(rateSlider.value),
      voiceURI: voiceSelect.value || null
    });
    showStatus("Читаю… (Alt+R)");
  } catch (e) {
    showStatus("Откройте обычную страницу и выделите текст.", true);
  }
});

btnStop.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) {
    try {
      await browser.tabs.sendMessage(tab.id, { action: "stop" });
    } catch (e) {
      /* нет content-скрипта — не критично */
    }
  }
  showStatus("Остановлено.");
});

btnSave.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) {
    showStatus("Нет активной вкладки.", true);
    return;
  }
  try {
    const { text } = await browser.tabs.sendMessage(tab.id, { action: "getSelectionText" });
    if (!text || !text.trim()) {
      showStatus("Сначала выделите текст на странице.", true);
      return;
    }
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "прочитай-мне.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showStatus("Текст сохранён.");
  } catch (e) {
    showStatus("Не удалось сохранить (откройте обычную страницу).", true);
  }
});

// --- Инициализация ----------------------------------------------------
loadSettings();
refreshVoices();
