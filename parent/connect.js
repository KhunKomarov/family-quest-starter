(() => {
  "use strict";
  const root = document.querySelector("#family-preview");
  window.FamilyConfig.profiles.forEach((name, index) => {
    const card = document.createElement("div");
    card.className = "child-chip";
    const image = document.createElement("img");
    image.src = "/parent/avatar/" + index + ".png";
    image.alt = "Фото: " + name;
    image.width = image.height = 64;
    const label = document.createElement("p");
    label.textContent = name;
    card.append(image, label);
    root.append(card);
  });
  const prompt = document.querySelector("#agent-request");
  prompt.value = [
    "Помоги подключить нашей семье «Семейный квест».",
    "Проект: https://github.com/KhunKomarov/family-quest-starter",
    "Кабинет нашей семьи: " + location.origin + "/parent/",
    "Семья уже зарегистрирована, сервер работает. Новый сервер и новая регистрация не нужны.",
    "Прочитай AGENTS.md и docs/agent-guide.md. Уточни модель телевизора и доступный компьютер, затем помоги установить детское приложение и проверить обмен с родительским кабинетом. При необходимости подключи совместимый экран машины.",
    "Если у тебя есть управление браузером и терминалом, доступные разрешённые действия выполняй сам: после моего входа скачай настройки через «Подключить экран», подготовь и установи APK, сохрани ключ подписи для обновлений. Личные коды я введу в окне входа.",
    "Если инструментов нет, объясняй конкретные действия по одному. В конце покажи, как добавлять дела, цели, проверять отметки и пользоваться копилкой."
  ].join("\n\n");
  document.querySelector("#copy-agent-request").addEventListener("click", async () => {
    const status = document.querySelector("#copy-agent-status");
    try {
      await navigator.clipboard.writeText(prompt.value);
      status.textContent = "Запрос скопирован. Вставьте его в чат своей нейросети.";
    } catch (_) {
      prompt.focus();
      prompt.select();
      status.textContent = "Текст выделен. Скопируйте его и вставьте в чат своей нейросети.";
    }
  });
})();
