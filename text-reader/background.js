// Создаём пункт в контекстном меню (оборачиваем в try,
// чтобы повторная загрузка фона не падала с "already exists").
try {
  browser.contextMenus.create({
    id: "read-aloud",
    title: "🔊 Прочитать выделенное",
    contexts: ["selection"]
  });
} catch (e) {
  console.warn("Прочитай меня: не удалось создать пункт меню:", e);
}

// Обработка клика по контекстному меню.
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "read-aloud" && info.selectionText) {
    if (tab && tab.id != null) {
      const { rate, voiceURI } = await browser.storage.local.get(["rate", "voiceURI"]);
      browser.tabs.sendMessage(tab.id, {
        action: "speak",
        text: info.selectionText,
        rate: typeof rate === "number" ? rate : 1.0,
        voiceURI: voiceURI || null
      });
    }
  }
});

// Горячая клавиша Alt+R — читаем текущее выделение на активной вкладке.
browser.commands.onCommand.addListener(async (command) => {
  if (command !== "read-selection") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const { rate, voiceURI } = await browser.storage.local.get(["rate", "voiceURI"]);
  browser.tabs.sendMessage(tab.id, {
    action: "readSelection",
    rate: typeof rate === "number" ? rate : 1.0,
    voiceURI: voiceURI || null
  });
});
