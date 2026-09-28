(() => {
  const form = document.getElementById("login-form");
  const error = document.getElementById("error");
  const submit = document.getElementById("submit");

  function safeNext() {
    const next = new URLSearchParams(location.search).get("next") || "/";
    // Só caminhos internos: nada de //host ou https://...
    return next.startsWith("/") && !next.startsWith("//") ? next : "/";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "Entrando…";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Calc": "1" },
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
        }),
      });
      if (res.ok) {
        location.replace(safeNext());
        return;
      }
      const body = await res.json().catch(() => ({}));
      error.textContent =
        res.status === 429 && !body.error
          ? "Muitas tentativas. Aguarde um minuto."
          : body.error || "Não foi possível entrar.";
    } catch {
      error.textContent = "Sem conexão com o servidor.";
    }
    error.hidden = false;
    submit.disabled = false;
    submit.textContent = "Entrar";
    form.password.select();
  });
})();
