(() => {
  "use strict";

  const icons = new Map([
    ["bed", "🛏️"],
    ["teeth", "🪥"],
    ["dress", "👕"],
    ["breakfast", "🥣"],
    ["car", "🎒 🚗"],
    ["wash", "🚿"],
    ["school", "🎒 🏠"],
    ["clothes", "👕 🗄️"],
    ["toys", "🧸 📦"],
    ["shoes", "👟"],
    ["dish-in", "🍽️ ⬇️"],
    ["dish-out", "🍽️ ⬆️"],
    ["trash", "🗑️"],
    ["bins-and-bags", "🪣 🗑️"],
    ["bins", "🪣"],
    ["bags", "🗑️"],
    ["reflective-vest", "🦺"],
    ["poem", "📜"],
    ["text", "📄"],
    ["read", "📖"],
    ["help", "🤝 📜"],
    ["song", "🎤"],
    ["ai-song", "🤖 🎤"],
    ["video", "🎥"]
  ]);

  // Parent-created tasks have generated IDs, so recognizable words supply their pictures.
  const byTitle = [
    [/спортивн\S* форм/, "👕 🎒"],
    [/фортепиано|пианино|клавиш/, "🎹"],
    [/посудомой|посудомоеч/, title => /разобрат|выгруз|достать/.test(title) ? "🍽️ ⬆️" : "🍽️ ⬇️"],
    [/светоотраж|жилет/, "🦺"],
    [/трениров|спортзал|упражнен|зарядк|бегат/, "🏃"],
    [/футбол/, "⚽"],
    [/плаван|бассейн/, "🏊"],
    [/гитар/, "🎸"],
    [/песня|песню|спеть|пение|вокал/, "🎤"],
    [/музык/, "🎵"],
    [/видео|снять ролик/, "🎥"],
    [/почист\S* зуб|зубн\S* щет/, "🪥"],
    [/кроват|постел/, "🛏️"],
    [/завтрак|поест|пообед|перекус/, "🥣"],
    [/душ|помыться|искуп/, "🚿"],
    [/стирать|стирк|стиральн/, "🧺"],
    [/одеться|одежд|футболк/, "👕"],
    [/обув|ботин|кроссов|тапоч/, "👟"],
    [/пакет.*ведр|мусор|мусорн/, "🗑️"],
    [/игруш|конструктор|лего/, "🧸"],
    [/полить|цветы|растени/, "🪴"],
    [/питом|кошк|кота|собак/, "🐾"],
    [/пылесос|подмест|подмет|вымыть пол/, "🧹"],
    [/вытер|влажн\S* уборк/, "🧽"],
    [/тарелк|посуд|накрыть на стол/, "🍽️"],
    [/стих/, "📜"],
    [/рисун|рисова|нарис/, "🎨"],
    [/прочит|почит|книг/, "📖"],
    [/урок|домашн\S* задан|напис|учеб|тетрад/, "✏️"],
    [/рюкзак|ранец/, "🎒"],
    [/машин|пристег/, "🚗"]
  ];

  function pictureFor(id, title) {
    const known = icons.get(id);
    if (known) return known;
    const normalized = title.toLowerCase().replace(/ё/g, "е");
    for (const [pattern, icon] of byTitle) {
      if (pattern.test(normalized)) return typeof icon === "function" ? icon(normalized) : icon;
    }
    return "📋";
  }

  // Draw newer pictograms locally for Android TV versions with older emoji fonts.
  const localPictures = new Map([
    ["🪥", '<path fill="#146f99" d="M13 27l23-23a3 3 0 014 4L17 31c-5 5-8 0-4-4Z"/><path fill="#65c9ef" d="M31 12l7-7 4 4-7 7z"/><path fill="#246f62" d="M23 18l4-4 3 3-4 4zM27 14l4-4 3 3-4 4zM31 10l4-4 3 3-4 4z"/>'],
    ["🪣", '<path d="M10 17a14 14 0 0128 0" fill="none" stroke="#56677f" stroke-width="3"/><path fill="#428eb2" d="M8 16h32l-5 22H13z"/><ellipse cx="24" cy="16" rx="16" ry="4" fill="#74c0db"/><path d="M12 25h24" stroke="#b6e7f7" stroke-width="3"/>'],
    ["🪴", '<path d="M24 29V12m0 12c-10 0-12-5-13-10 9 0 13 3 13 10Zm0-5c0-8 4-12 12-14-1 8-5 12-12 14Z" fill="#327d4e" stroke="#327d4e" stroke-width="2"/><path fill="#c16a3b" d="M10 27h28l-5 13H15z"/><rect x="9" y="26" width="30" height="5" rx="2" fill="#e78a52"/>'],
    ["🦺", '<path fill="#df751b" d="M16 6h6l2 11 2-11h6l6 11v23H10V17z"/><path d="M13 29h22M13 34h22" stroke="#fff0ba" stroke-width="3"/><path d="M24 17v23" stroke="#a44916" stroke-width="2"/>']
  ]);

  window.familyTaskIcon = (id, title, container) => {
    const symbols = pictureFor(id, title).split(" ");
    if (symbols.length > 1) container.classList.add("quest-task-pair");
    for (const symbol of symbols) {
      const picture = localPictures.get(symbol);
      if (!picture) {
        const glyph = document.createElement("span");
        glyph.textContent = symbol;
        container.append(glyph);
        continue;
      }
      const image = document.createElement("img");
      image.alt = "";
      image.src = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 44">' + picture + '</svg>');
      container.append(image);
    }
  };
})();
