/**
 * Textos do upstream que afirmam "os dados ficam só no navegador" — falso no
 * modo servidor. Sobrescritos em tempo de execução para não editar os JSON de
 * locale do upstream (conflito a cada update).
 */
import type { i18n as I18n } from "i18next";

const OVERRIDES: Record<"pt-BR" | "en-US", Record<string, string>> = {
  "pt-BR": {
    "privacy.consent.item1":
      "Os dados ficam no servidor da ModelInk3D (calc.modelink3d.link), acessíveis só com login, com uma cópia de trabalho neste navegador.",
    "privacy.consent.item2": "Nenhum dado é compartilhado com terceiros.",
    "privacy.consent.item4":
      "Limpar o cache do navegador não apaga nada: ao entrar de novo, os dados voltam do servidor.",
    "sync.export.description": "Exporte uma cópia de todos os dados para um arquivo.",
    "sync.lgpd_notice":
      "Os dados ficam no servidor da ModelInk3D, protegidos por login. Nada é compartilhado com terceiros.",
    "tutorial.steps.qc-complete.description":
      "Cliente cadastrado e orçamento vinculado: agora é só exportar em PDF e enviar. Tudo fica salvo no servidor, disponível em qualquer computador.",
  },
  "en-US": {
    "privacy.consent.item1":
      "Data is stored on the ModelInk3D server (calc.modelink3d.link), login required, with a working copy in this browser.",
    "privacy.consent.item2": "No data is shared with third parties.",
    "privacy.consent.item4":
      "Clearing the browser cache deletes nothing: data is restored from the server on the next login.",
    "sync.export.description": "Export a copy of all data to a file.",
    "sync.lgpd_notice":
      "Data is stored on the ModelInk3D server, protected by login. Nothing is shared with third parties.",
    "tutorial.steps.qc-complete.description":
      "Customer saved and quote linked: now just export the PDF and send it. Everything is saved on the server, available on any computer.",
  },
};

function nest(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Record<string, unknown>;
    }
    node[parts.at(-1)!] = value;
  }
  return out;
}

export function applyServerModeTexts(i18n: I18n): void {
  for (const [lng, texts] of Object.entries(OVERRIDES)) {
    i18n.addResourceBundle(lng, "translation", nest(texts), true, true);
  }
}
