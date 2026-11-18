# Сервер для одной семьи

Если вы подключаетесь по приглашению к серверу автора, аренда нового VPS не нужна: [инструкция для семьи](hosted.md). Несколько изолированных экземпляров на одном VPS настраивает его владелец по [инструкции администратора](operator-hosting.md).

## Что выбрать

**Для одной семьи, у которой телевизор, два родительских телефона и экран в машине, начните с VPS на 1 vCPU, 512 МиБ RAM и 10 ГиБ SSD.** Это конфигурация рабочей домашней установки. В комплекте Python, SQLite и HTTPS-прокси. Android-приложение собирается на компьютере семьи.

| Сценарий | Вариант |
| --- | --- |
| Посмотреть демо и проверить панель | Запуск на своём компьютере по [инструкции](install.md#1-локальная-проверка) |
| Постоянная синхронизация дома и через LTE | VPS с Linux и HTTPS. Ориентир — DigitalOcean Droplet Basic Regular, 512 МиБ за $4 в месяц |
| Уже есть Linux-сервер | Можно использовать его. Нужен HTTPS-адрес, доступный из сетей выбранных устройств |

Рабочий пример использует DigitalOcean в Сингапуре (SGP1), Ubuntu 24.04 LTS, Nginx и Python-службу под systemd. Сингапур подходит для нашей установки в Таиланде. Для семьи в другой стране выбирайте доступный регион ближе к её основной сети. В инструкции ниже используется Caddy как вариант с автоматическим сертификатом. Подойдёт и Nginx с уже настроенным HTTPS. [Тарифы DigitalOcean](https://www.digitalocean.com/pricing/droplets) · [Доступность регионов](https://docs.digitalocean.com/platform/regional-availability/) · [Автоматический HTTPS в Caddy](https://caddyserver.com/docs/automatic-https)

На рабочем сервере при проверке 17 ноября 2026 года служба занимала около **16 МиБ RAM**, системе было доступно около **274 МиБ**, корневой раздел был заполнен на **38%**. Служба работала, средняя нагрузка за минуту составляла **0,08** при одном vCPU. Это снимок работы одной семьи. При добавлении других служб или нескольких семей измеряйте память, диск и время ответа и при необходимости увеличивайте тариф. Текущий шаблон рассчитан на отдельный экземпляр для каждой семьи.

## Постоянный запуск на Ubuntu

1. Подготовьте Ubuntu 24.04 LTS и домен. Установите Python и утилиту SQLite командами `sudo apt update` и `sudo apt install python3 sqlite3`. Установите Caddy или используйте существующий HTTPS-прокси. Направьте DNS домена на сервер и разрешите входящие 80/TCP и 443/TCP для Caddy. Сервер Python слушает только локальный порт 8765. [Установка Caddy](https://caddyserver.com/docs/install)
2. Из корня скачанного репозитория установите приложение и создайте закрытый каталог для данных. Команды рассчитаны на первую установку. Для обновления скопируйте новые файлы приложения и перезапустите службу после резервной копии.

   ```sh
   sudo useradd --system --user-group --no-create-home \
     --home-dir /var/lib/family-quest --shell /usr/sbin/nologin family-quest
   sudo install -d -m 0755 /opt/family-quest /etc/family-quest
   sudo install -d -m 0700 -o family-quest -g family-quest /var/lib/family-quest
   sudo cp -R config parent scripts sync web /opt/family-quest/
   sudo python3 /opt/family-quest/scripts/configure.py
   sudo install -m 0644 deploy/family-quest.service /etc/systemd/system/family-quest.service
   ```

3. Замените домен примера на свой. Сгенерируйте коды и параметры устройств один раз. Для установки только на телевизор оставьте `--device tv:tv`.

   ```sh
   sudo -u family-quest python3 /opt/family-quest/scripts/init-instance.py \
     --directory /var/lib/family-quest --origin https://tracker.example.org \
     --device tv:tv --device car:car
   printf '%s\n' 'FAMILY_QUEST_ORIGIN=https://tracker.example.org' |
     sudo tee /etc/family-quest/origin.env >/dev/null
   sudo systemctl daemon-reload
   sudo systemctl enable --now family-quest
   sudo systemctl is-active family-quest
   ```

4. Включите прокси для своего домена. Caddyfile ниже подходит для отдельного VPS. Если на прокси уже есть другие сайты, добавьте этот блок к существующим. После проверки конфигурации перезагрузите Caddy.

   ```caddyfile
   tracker.example.org {
       reverse_proxy 127.0.0.1:8765
   }
   ```

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   curl -fsS -o /dev/null https://tracker.example.org/parent/
   ```

5. Откройте `https://tracker.example.org/parent/` на каждом телефоне. Каждый родитель входит со своим кодом из `/var/lib/family-quest/parents.json`. Передайте файлы `.properties` из этого каталога на компьютер сборки по закрытому каналу и [соберите APK](install.md#3-сборка-детского-приложения). Проверьте появление задания и отметки на двух экранах, в том числе вне домашней сети, если это нужно семье.

Рабочая база находится в `/var/lib/family-quest/journal.sqlite3`. Сделайте резервную копию перед обновлением через `sqlite3` командой `.backup`. Проверяйте `systemctl is-active family-quest` и `journalctl -u family-quest` после изменений. Для архивов и данных входа используйте каталоги с частным доступом.
