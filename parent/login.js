"use strict";

const form = document.querySelector("#login");
form.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = form.querySelector("button");
  const status = document.querySelector("#login-status");
  submit.disabled = true;
  status.textContent = "";
  try {
    const response = await fetch("/parent/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: document.querySelector("#access-code").value.trim() })
    });
    if (response.ok) location.reload();
    else if (response.status === 401) status.textContent = "Код доступа не подошёл.";
    else if (response.status === 429) status.textContent = "Слишком много попыток. Попробуй позже.";
    else status.textContent = "Не удалось войти. Попробуй ещё раз.";
  } catch (_) {
    status.textContent = "Нет связи с журналом.";
  } finally {
    submit.disabled = false;
  }
});
